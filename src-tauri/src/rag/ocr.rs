use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use image::{DynamicImage, GenericImageView, RgbImage};
use ndarray::Array4;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Value;

use super::config as rag_config;

// --- Model configuration ---

const DET_MODEL_FILE: &str = "pp-ocrv4-det.onnx";

// Two recognition models: Latin/English (PP-OCRv4) and Cyrillic (PP-OCRv3)
const REC_EN_MODEL_FILE: &str = "en-pp-ocrv4-rec.onnx";
const REC_EN_DICT_FILE: &str = "en_dict.txt";
const REC_CYR_MODEL_FILE: &str = "cyrillic-pp-ocrv3-rec.onnx";
const REC_CYR_DICT_FILE: &str = "cyrillic_dict.txt";

// HuggingFace-hosted PP-OCR ONNX models (RapidOCR community exports)
const DET_MODEL_URL: &str =
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx";
const REC_EN_MODEL_URL: &str =
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/en_PP-OCRv4_rec_infer.onnx";
const REC_EN_DICT_URL: &str =
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/en_dict.txt";
const REC_CYR_MODEL_URL: &str =
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/cyrillic_PP-OCRv3_rec_infer.onnx";
const REC_CYR_DICT_URL: &str =
    "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/cyrillic_dict.txt";

// ImageNet normalization constants
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

// Detection parameters
const DET_MAX_SIDE: u32 = 960;
const DET_THRESH: f32 = 0.3;
const DET_MIN_BOX_SIZE: u32 = 5;

// Recognition parameters
const REC_IMG_HEIGHT: u32 = 48;
const REC_MAX_WIDTH: u32 = 320;

// Safety limit: max pages to OCR per document
const MAX_OCR_PAGES: usize = 100;

// HTTP timeout for model downloads (5 min for large models)
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

// --- OCR Engine ---
// Mutex<Option> instead of OnceLock so that initialization errors are retried
// on the next call rather than cached forever (e.g. if network was temporarily down).
// The outer Mutex serializes all OCR access, so inner sessions don't need their own Mutex.

struct RecModel {
    session: Session,
    dictionary: Vec<String>,
    name: &'static str,
    output_name: String,
}

struct OcrEngine {
    det_session: Session,
    det_output_name: String,
    rec_models: Vec<RecModel>,
}

static OCR_ENGINE: Mutex<Option<OcrEngine>> = Mutex::new(None);

/// Run a closure with the initialized OCR engine. Retries initialization on each call
/// if the previous attempt failed (e.g. network error during model download).
fn with_engine<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut OcrEngine) -> Result<T, String>,
{
    let mut guard = OCR_ENGINE
        .lock()
        .map_err(|e| format!("OCR engine lock poisoned: {e}"))?;

    if guard.is_none() {
        *guard = Some(init_engine()?);
    }

    f(guard.as_mut().expect("just initialized"))
}

fn load_session(path: PathBuf, label: &str) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("Failed to create {label} session builder: {e}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| format!("Failed to set {label} optimization level: {e}"))?
        .with_intra_threads(2)
        .map_err(|e| format!("Failed to set {label} threads: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("Failed to load {label} model: {e}"))
}

fn load_dictionary(path: PathBuf) -> Result<Vec<String>, String> {
    let dict_text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read dictionary {}: {e}", path.display()))?;
    let mut dictionary: Vec<String> = dict_text.lines().map(|l| l.to_string()).collect();
    // PP-OCR dictionary: index 0 = blank (CTC), last = space
    dictionary.insert(0, String::new()); // blank token at index 0
    dictionary.push(" ".to_string()); // space at end
    Ok(dictionary)
}

fn first_output_name(session: &Session, label: &str) -> Result<String, String> {
    session
        .outputs()
        .first()
        .map(|o| o.name().to_string())
        .ok_or_else(|| format!("{label} model has no outputs"))
}

fn init_engine() -> Result<OcrEngine, String> {
    let models_dir = ocr_models_dir();
    fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create OCR models dir: {e}"))?;

    let client = reqwest::blocking::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    // Download all models if missing
    let downloads = [
        (DET_MODEL_FILE, DET_MODEL_URL),
        (REC_EN_MODEL_FILE, REC_EN_MODEL_URL),
        (REC_EN_DICT_FILE, REC_EN_DICT_URL),
        (REC_CYR_MODEL_FILE, REC_CYR_MODEL_URL),
        (REC_CYR_DICT_FILE, REC_CYR_DICT_URL),
    ];
    for (file, url) in downloads {
        download_if_missing(&client, &models_dir.join(file), url)?;
    }

    eprintln!("[rag/ocr] Loading detection model...");
    let det_session = load_session(models_dir.join(DET_MODEL_FILE), "det")?;
    let det_output_name = first_output_name(&det_session, "det")?;
    eprintln!("[rag/ocr] Det output name: {det_output_name}");

    eprintln!("[rag/ocr] Loading English/Latin recognition model...");
    let en_session = load_session(models_dir.join(REC_EN_MODEL_FILE), "rec-en")?;
    let en_output_name = first_output_name(&en_session, "rec-en")?;
    let en_dict = load_dictionary(models_dir.join(REC_EN_DICT_FILE))?;

    eprintln!("[rag/ocr] Loading Cyrillic recognition model...");
    let cyr_session = load_session(models_dir.join(REC_CYR_MODEL_FILE), "rec-cyr")?;
    let cyr_output_name = first_output_name(&cyr_session, "rec-cyr")?;
    let cyr_dict = load_dictionary(models_dir.join(REC_CYR_DICT_FILE))?;

    eprintln!(
        "[rag/ocr] OCR engine initialized (en dict: {}, cyr dict: {})",
        en_dict.len(),
        cyr_dict.len()
    );

    Ok(OcrEngine {
        det_session,
        det_output_name,
        rec_models: vec![
            RecModel {
                session: en_session,
                dictionary: en_dict,
                name: "en",
                output_name: en_output_name,
            },
            RecModel {
                session: cyr_session,
                dictionary: cyr_dict,
                name: "cyr",
                output_name: cyr_output_name,
            },
        ],
    })
}

fn ocr_models_dir() -> PathBuf {
    rag_config::models_dir().join("ocr")
}

// --- Model download ---

fn download_if_missing(
    client: &reqwest::blocking::Client,
    path: &Path,
    url: &str,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    eprintln!("[rag/ocr] Downloading {file_name}...");

    let response = client
        .get(url)
        .send()
        .map_err(|e| format!("Failed to download {file_name}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download {file_name}: HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .map_err(|e| format!("Failed to read {file_name} response: {e}"))?;

    // Write to temp file then rename (atomic)
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, &bytes)
        .map_err(|e| format!("Failed to write {file_name}: {e}"))?;
    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename {file_name}: {e}"))?;

    eprintln!(
        "[rag/ocr] Downloaded {file_name} ({:.1} MB)",
        bytes.len() as f64 / 1_048_576.0
    );
    Ok(())
}

// --- Public API ---

/// Extract text from a scanned PDF using OCR (PP-OCR via ONNX Runtime).
/// Uses dual recognition models (Latin + Cyrillic), picks best by confidence.
/// Called from parser.rs as a third fallback when pdftotext and pdf-extract
/// both return empty text. Runs in spawn_blocking context.
///
/// Pages are processed one at a time to avoid OOM on large PDFs.
pub fn ocr_pdf(path: &Path) -> Result<String, String> {
    let page_count = get_page_count(path)?;
    if page_count == 0 {
        return Err("PDF has 0 pages".into());
    }

    let pages_to_process = page_count.min(MAX_OCR_PAGES);
    if page_count > MAX_OCR_PAGES {
        eprintln!(
            "[rag/ocr] PDF has {page_count} pages, limiting OCR to first {MAX_OCR_PAGES}"
        );
    }

    let mut all_text = String::new();

    // Process one page at a time to keep memory bounded
    for page_num in 1..=pages_to_process {
        let img = match render_single_page(path, page_num) {
            Ok(img) => img,
            Err(e) => {
                eprintln!("[rag/ocr] Page {page_num} render failed: {e}");
                continue;
            }
        };

        let result = with_engine(|engine| ocr_image(engine, &img));
        match result {
            Ok(text) => {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    if !all_text.is_empty() {
                        all_text.push_str("\n\n");
                    }
                    all_text.push_str(trimmed);
                }
            }
            Err(e) => {
                eprintln!("[rag/ocr] Page {page_num} OCR failed: {e}");
            }
        }
        // img is dropped here — memory for this page is freed before next page
    }

    if all_text.trim().is_empty() {
        return Err("OCR produced no text".into());
    }

    Ok(all_text)
}

// --- PDF page handling ---

/// Get page count using pdfinfo (poppler-utils).
fn get_page_count(path: &Path) -> Result<usize, String> {
    let path_str = path.to_str().ok_or("Invalid path encoding")?;
    let output = Command::new("pdfinfo")
        .arg(path_str)
        .output()
        .map_err(|e| format!("pdfinfo not available: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pdfinfo failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("Pages:") {
            let count = rest
                .trim()
                .parse::<usize>()
                .map_err(|e| format!("Failed to parse page count: {e}"))?;
            return Ok(count);
        }
    }

    Err("pdfinfo did not report page count".into())
}

/// Render a single PDF page to an image using pdftoppm.
/// Uses -f/-l to select page and -singlefile to produce exactly one output.
fn render_single_page(path: &Path, page_num: usize) -> Result<DynamicImage, String> {
    let path_str = path.to_str().ok_or("Invalid path encoding")?;
    let tmp_dir =
        tempfile::tempdir().map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let prefix = tmp_dir.path().join("page");
    let prefix_str = prefix.to_str().ok_or("Invalid temp path")?;

    let page_str = page_num.to_string();
    let output = Command::new("pdftoppm")
        .args([
            "-f",
            &page_str,
            "-l",
            &page_str,
            "-singlefile",
            "-r",
            "300",
            "-png",
            path_str,
            prefix_str,
        ])
        .output()
        .map_err(|e| format!("pdftoppm not available: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pdftoppm failed for page {page_num}: {stderr}"));
    }

    // -singlefile produces exactly one file: {prefix}.png
    let png_path = prefix.with_extension("png");
    image::open(&png_path).map_err(|e| format!("Failed to open page {page_num} image: {e}"))
}

// --- OCR pipeline for a single image ---

fn ocr_image(engine: &mut OcrEngine, image: &DynamicImage) -> Result<String, String> {
    // 1. Detect text regions
    let boxes = detect_text(&mut engine.det_session, &engine.det_output_name, image)
        .map_err(|e| format!("Detection failed: {e}"))?;

    if boxes.is_empty() {
        return Ok(String::new());
    }

    // 2. Sort boxes top-to-bottom, then left-to-right
    let mut sorted_boxes = boxes;
    sorted_boxes.sort_by(|a, b| {
        let y_cmp = a.y.cmp(&b.y);
        if y_cmp == std::cmp::Ordering::Equal {
            a.x.cmp(&b.x)
        } else {
            y_cmp
        }
    });

    // 3. Recognize text in each box using all models, pick best by confidence
    let mut lines = Vec::new();
    for bbox in &sorted_boxes {
        let cropped = image.crop_imm(bbox.x, bbox.y, bbox.w, bbox.h);
        let best = recognize_best(&mut engine.rec_models, &cropped);
        if let Some((text, _confidence, _model_name)) = best {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() {
                lines.push(trimmed);
            }
        }
    }

    Ok(lines.join("\n"))
}

/// Confidence threshold: if first model scores above this, skip remaining models.
const HIGH_CONFIDENCE_THRESH: f32 = 0.8;

/// Run recognition models on a cropped image, return (text, confidence, model_name)
/// for the model with highest confidence. If the first model scores above
/// HIGH_CONFIDENCE_THRESH, remaining models are skipped to halve inference cost.
/// Returns None if all models fail or produce empty text.
fn recognize_best(
    models: &mut [RecModel],
    image: &DynamicImage,
) -> Option<(String, f32, &'static str)> {
    let mut best: Option<(String, f32, &'static str)> = None;

    for model in models.iter_mut() {
        match recognize_text(&mut model.session, &model.output_name, image, &model.dictionary) {
            Ok((text, confidence)) => {
                if text.trim().is_empty() {
                    continue;
                }
                let is_better = match &best {
                    Some((_, best_conf, _)) => confidence > *best_conf,
                    None => true,
                };
                if is_better {
                    best = Some((text, confidence, model.name));
                }
                // Early exit: high confidence means this model's script matches well,
                // no need to try remaining models
                if confidence > HIGH_CONFIDENCE_THRESH {
                    break;
                }
            }
            Err(e) => {
                eprintln!("[rag/ocr] Recognition failed ({}): {e}", model.name);
            }
        }
    }

    best
}

// --- Detection ---

#[derive(Debug, Clone)]
struct TextBox {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

fn detect_text(
    session: &mut Session,
    output_name: &str,
    image: &DynamicImage,
) -> Result<Vec<TextBox>, String> {
    let (orig_w, orig_h) = image.dimensions();

    // Resize maintaining aspect ratio, max side = DET_MAX_SIDE, dimensions must be multiples of 32
    let scale = (DET_MAX_SIDE as f32) / (orig_w.max(orig_h) as f32);
    let scale = scale.min(1.0);
    let new_w = ((orig_w as f32 * scale) as u32).max(32);
    let new_h = ((orig_h as f32 * scale) as u32).max(32);
    let new_w = new_w.div_ceil(32) * 32;
    let new_h = new_h.div_ceil(32) * 32;

    let resized = image.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
    let rgb = resized.to_rgb8();

    // Build input tensor [1, 3, H, W] normalized with ImageNet stats
    let tensor = image_to_tensor(&rgb, new_h, new_w);
    let input_value = Value::from_array(tensor)
        .map_err(|e| format!("Failed to create det input tensor: {e}"))?;

    let outputs = session
        .run(ort::inputs!["x" => input_value])
        .map_err(|e| format!("Detection inference failed: {e}"))?;

    // Access output by name (not .values().next() which has undefined order)
    let output_value = &outputs[output_name];

    let (_, prob_data) = output_value
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Failed to extract det output: {e}"))?;

    // Threshold to binary mask and find connected component bounding boxes
    let boxes = find_text_boxes(prob_data, new_w, new_h, orig_w, orig_h);

    Ok(boxes)
}

fn image_to_tensor(rgb: &RgbImage, h: u32, w: u32) -> Array4<f32> {
    let mut tensor = Array4::<f32>::zeros((1, 3, h as usize, w as usize));

    for y in 0..h {
        for x in 0..w {
            let pixel = rgb.get_pixel(x, y);
            for c in 0..3 {
                let val = pixel[c] as f32 / 255.0;
                tensor[[0, c, y as usize, x as usize]] = (val - MEAN[c]) / STD[c];
            }
        }
    }

    tensor
}

fn find_text_boxes(
    prob_data: &[f32],
    map_w: u32,
    map_h: u32,
    orig_w: u32,
    orig_h: u32,
) -> Vec<TextBox> {
    let w = map_w as usize;
    let h = map_h as usize;

    // Create binary mask
    let mut visited = vec![false; w * h];
    let mut binary = vec![false; w * h];
    for i in 0..prob_data.len().min(w * h) {
        binary[i] = prob_data[i] > DET_THRESH;
    }

    let scale_x = orig_w as f32 / map_w as f32;
    let scale_y = orig_h as f32 / map_h as f32;

    // BFS flood-fill to find connected components
    let mut boxes = Vec::new();
    for start_y in 0..h {
        for start_x in 0..w {
            let idx = start_y * w + start_x;
            if !binary[idx] || visited[idx] {
                continue;
            }

            // BFS to find component bounds
            let mut queue = VecDeque::new();
            queue.push_back((start_x, start_y));
            visited[idx] = true;

            let mut min_x = start_x;
            let mut min_y = start_y;
            let mut max_x = start_x;
            let mut max_y = start_y;

            while let Some((cx, cy)) = queue.pop_front() {
                min_x = min_x.min(cx);
                min_y = min_y.min(cy);
                max_x = max_x.max(cx);
                max_y = max_y.max(cy);

                for (dx, dy) in [(-1i32, 0), (1, 0), (0, -1), (0, 1)] {
                    let nx = cx as i32 + dx;
                    let ny = cy as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                        let ni = ny as usize * w + nx as usize;
                        if binary[ni] && !visited[ni] {
                            visited[ni] = true;
                            queue.push_back((nx as usize, ny as usize));
                        }
                    }
                }
            }

            // Scale back to original image coordinates
            let bx = (min_x as f32 * scale_x) as u32;
            let by = (min_y as f32 * scale_y) as u32;
            let bw = ((max_x - min_x + 1) as f32 * scale_x) as u32;
            let bh = ((max_y - min_y + 1) as f32 * scale_y) as u32;

            // Filter out tiny boxes
            if bw >= DET_MIN_BOX_SIZE && bh >= DET_MIN_BOX_SIZE {
                // Expand box slightly for better recognition
                let pad_x = (bw as f32 * 0.05) as u32;
                let pad_y = (bh as f32 * 0.05) as u32;
                boxes.push(TextBox {
                    x: bx.saturating_sub(pad_x),
                    y: by.saturating_sub(pad_y),
                    w: (bw + 2 * pad_x).min(orig_w.saturating_sub(bx.saturating_sub(pad_x))),
                    h: (bh + 2 * pad_y).min(orig_h.saturating_sub(by.saturating_sub(pad_y))),
                });
            }
        }
    }

    boxes
}

// --- Recognition ---

/// Run recognition on a cropped image. Returns (text, confidence).
/// Confidence is the average softmax probability of the best class at each CTC timestep
/// (excluding blank predictions). Range: 0.0 to 1.0.
fn recognize_text(
    session: &mut Session,
    output_name: &str,
    image: &DynamicImage,
    dictionary: &[String],
) -> Result<(String, f32), String> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return Ok((String::new(), 0.0));
    }

    // Resize to fixed height, scale width proportionally
    let new_h = REC_IMG_HEIGHT;
    let new_w = ((w as f32 / h as f32) * new_h as f32) as u32;
    let new_w = new_w.clamp(1, REC_MAX_WIDTH);

    let resized = image.resize_exact(new_w, new_h, image::imageops::FilterType::Lanczos3);
    let rgb = resized.to_rgb8();

    let tensor = image_to_tensor(&rgb, new_h, new_w);
    let input_value = Value::from_array(tensor)
        .map_err(|e| format!("Failed to create rec input tensor: {e}"))?;

    let outputs = session
        .run(ort::inputs!["x" => input_value])
        .map_err(|e| format!("Recognition inference failed: {e}"))?;

    // Access output by name (not .values().next() which has undefined order)
    let output_value = &outputs[output_name];

    let (shape, logits) = output_value
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("Failed to extract rec output: {e}"))?;

    // Output shape: [1, seq_len, num_classes]
    let seq_len = shape[1] as usize;
    let num_classes = shape[2] as usize;

    Ok(ctc_decode_with_confidence(
        logits, seq_len, num_classes, dictionary,
    ))
}

/// CTC greedy decode: argmax per timestep, collapse repeats, remove blanks.
/// Also computes average confidence (softmax probability of chosen class at non-blank timesteps).
fn ctc_decode_with_confidence(
    logits: &[f32],
    seq_len: usize,
    num_classes: usize,
    dictionary: &[String],
) -> (String, f32) {
    let mut result = String::new();
    let mut prev_idx: usize = 0; // blank
    let mut confidence_sum: f32 = 0.0;
    let mut confidence_count: u32 = 0;

    for t in 0..seq_len {
        let offset = t * num_classes;
        let slice = &logits[offset..offset + num_classes];

        // Find argmax
        let mut best_idx = 0;
        let mut best_val = f32::NEG_INFINITY;
        for (i, &val) in slice.iter().enumerate() {
            if val > best_val {
                best_val = val;
                best_idx = i;
            }
        }

        // CTC: skip blanks (index 0) and repeated characters
        if best_idx != 0 && best_idx != prev_idx {
            if let Some(ch) = dictionary.get(best_idx) {
                result.push_str(ch);
            }
            // Compute softmax probability for this timestep's best class
            let max_logit = best_val;
            let exp_sum: f32 = slice.iter().map(|&v| (v - max_logit).exp()).sum();
            let prob = 1.0 / exp_sum; // exp(max - max) / sum = 1 / sum
            confidence_sum += prob;
            confidence_count += 1;
        }
        prev_idx = best_idx;
    }

    let confidence = if confidence_count > 0 {
        confidence_sum / confidence_count as f32
    } else {
        0.0
    };

    (result, confidence)
}
