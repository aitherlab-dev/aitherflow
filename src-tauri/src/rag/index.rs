use arrow_array::{
    cast::AsArray, Array, FixedSizeListArray, Float32Array, RecordBatch, RecordBatchIterator,
    RecordBatchReader, StringArray, UInt32Array,
};
use arrow_schema::{ArrowError, DataType, Field, Schema};
use lancedb::query::{ExecutableQuery, QueryBase};
use std::sync::Arc;

use super::config as rag_config;
use super::embedder;

const TABLE_NAME: &str = "chunks";

/// A single search result.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub text: String,
    pub document_id: String,
    pub chunk_index: u32,
    pub score: f32,
}

/// Index status info.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub total_chunks: u64,
    pub has_index: bool,
}

fn schema() -> Arc<Schema> {
    let dim = embedder::embedding_dimension() as i32;
    Arc::new(Schema::new(vec![
        Field::new("text", DataType::Utf8, false),
        Field::new("document_id", DataType::Utf8, false),
        Field::new("chunk_index", DataType::UInt32, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
    ]))
}

/// Create a Box<dyn RecordBatchReader + Send> from batches — the type lancedb expects.
fn make_reader(
    batches: Vec<RecordBatch>,
    s: Arc<Schema>,
) -> Box<dyn RecordBatchReader + Send> {
    let items: Vec<Result<RecordBatch, ArrowError>> = batches.into_iter().map(Ok).collect();
    Box::new(RecordBatchIterator::new(items, s))
}

async fn open_db(base_id: &str) -> Result<lancedb::Connection, String> {
    let lance_dir = rag_config::base_lance_dir(base_id);
    std::fs::create_dir_all(&lance_dir)
        .map_err(|e| format!("Failed to create lance dir: {e}"))?;

    lancedb::connect(lance_dir.to_string_lossy().as_ref())
        .execute()
        .await
        .map_err(|e| format!("Failed to open LanceDB: {e}"))
}

async fn get_or_create_table(
    db: &lancedb::Connection,
) -> Result<lancedb::Table, String> {
    let names = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("Failed to list tables: {e}"))?;

    if names.contains(&TABLE_NAME.to_string()) {
        db.open_table(TABLE_NAME)
            .execute()
            .await
            .map_err(|e| format!("Failed to open table: {e}"))
    } else {
        let s = schema();
        let batch = RecordBatch::new_empty(s.clone());
        let reader = make_reader(vec![batch], s);
        db.create_table(TABLE_NAME, reader)
            .execute()
            .await
            .map_err(|e| format!("Failed to create table: {e}"))
    }
}

/// Build a FixedSizeListArray from flat f32 values.
fn build_vector_array(
    embeddings: &[Vec<f32>],
    dim: i32,
) -> Result<Arc<dyn Array>, String> {
    let flat_values: Vec<f32> = embeddings.iter().flatten().copied().collect();
    let values_array = Float32Array::from(flat_values);
    let field = Arc::new(Field::new("item", DataType::Float32, true));
    let arr = FixedSizeListArray::try_new(field, dim, Arc::new(values_array), None)
        .map_err(|e| format!("Failed to create vector array: {e}"))?;
    Ok(Arc::new(arr))
}

/// Add chunks with their embeddings to the index.
pub async fn add_chunks(
    base_id: &str,
    document_id: &str,
    texts: &[String],
    embeddings: &[Vec<f32>],
) -> Result<(), String> {
    if texts.is_empty() {
        return Ok(());
    }

    let db = open_db(base_id).await?;
    let table = get_or_create_table(&db).await?;
    let dim = embedder::embedding_dimension() as i32;

    let text_array = Arc::new(StringArray::from(
        texts.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    )) as Arc<dyn Array>;

    let doc_ids: Vec<&str> = vec![document_id; texts.len()];
    let doc_id_array = Arc::new(StringArray::from(doc_ids)) as Arc<dyn Array>;

    let indices: Vec<u32> = (0..texts.len() as u32).collect();
    let index_array = Arc::new(UInt32Array::from(indices)) as Arc<dyn Array>;

    let vector_array = build_vector_array(embeddings, dim)?;

    let s = schema();
    let batch = RecordBatch::try_new(
        s.clone(),
        vec![text_array, doc_id_array, index_array, vector_array],
    )
    .map_err(|e| format!("Failed to create record batch: {e}"))?;

    let reader = make_reader(vec![batch], s);
    table
        .add(reader)
        .execute()
        .await
        .map_err(|e| format!("Failed to add chunks to index: {e}"))?;

    Ok(())
}

/// Remove all chunks belonging to a document from the index.
pub async fn remove_document_chunks(base_id: &str, document_id: &str) -> Result<(), String> {
    let db = open_db(base_id).await?;
    let names = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("Failed to list tables: {e}"))?;

    if !names.contains(&TABLE_NAME.to_string()) {
        return Ok(());
    }

    let table = db
        .open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Failed to open table: {e}"))?;

    table
        .delete(&format!("document_id = '{document_id}'"))
        .await
        .map_err(|e| format!("Failed to delete chunks: {e}"))?;

    Ok(())
}

/// Search for similar chunks using vector similarity.
pub async fn search(
    base_id: &str,
    query_embedding: &[f32],
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    let db = open_db(base_id).await?;
    let names = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("Failed to list tables: {e}"))?;

    if !names.contains(&TABLE_NAME.to_string()) {
        return Ok(Vec::new());
    }

    let table = db
        .open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Failed to open table: {e}"))?;

    let results = table
        .vector_search(query_embedding)
        .map_err(|e| format!("Failed to create search query: {e}"))?
        .limit(limit)
        .execute()
        .await
        .map_err(|e| format!("Failed to execute search: {e}"))?;

    use futures_util::TryStreamExt;
    let batches: Vec<RecordBatch> = results
        .try_collect()
        .await
        .map_err(|e| format!("Failed to collect search results: {e}"))?;

    let mut out = Vec::new();
    for batch in &batches {
        let texts = batch
            .column_by_name("text")
            .ok_or("Missing 'text' column")?
            .as_string::<i32>();
        let doc_ids = batch
            .column_by_name("document_id")
            .ok_or("Missing 'document_id' column")?
            .as_string::<i32>();
        let chunk_indices = batch
            .column_by_name("chunk_index")
            .ok_or("Missing 'chunk_index' column")?
            .as_primitive::<arrow_array::types::UInt32Type>();
        let distances = batch
            .column_by_name("_distance")
            .ok_or("Missing '_distance' column")?
            .as_primitive::<arrow_array::types::Float32Type>();

        for i in 0..batch.num_rows() {
            out.push(SearchResult {
                text: texts.value(i).to_string(),
                document_id: doc_ids.value(i).to_string(),
                chunk_index: chunk_indices.value(i),
                score: 1.0 - distances.value(i),
            });
        }
    }

    Ok(out)
}

/// Get index status for a knowledge base.
pub async fn get_status(base_id: &str) -> Result<IndexStatus, String> {
    let db = open_db(base_id).await?;
    let names = db
        .table_names()
        .execute()
        .await
        .map_err(|e| format!("Failed to list tables: {e}"))?;

    if !names.contains(&TABLE_NAME.to_string()) {
        return Ok(IndexStatus {
            total_chunks: 0,
            has_index: false,
        });
    }

    let table = db
        .open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Failed to open table: {e}"))?;

    let count = table
        .count_rows(None)
        .await
        .map_err(|e| format!("Failed to count rows: {e}"))?;

    Ok(IndexStatus {
        total_chunks: count as u64,
        has_index: count > 0,
    })
}
