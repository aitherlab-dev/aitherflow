use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

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

// --- OCR Engine (lazy singleton) ---
// Sessions wrapped in Mutex because ort v2 session.run() requires &mut self.

struct RecModel {
    session: Mutex<Session>,
    dictionary: Vec<String>,
    name: &'static str,
}

struct OcrEngine {
    det_session: Mutex<Session>,
    rec_models: Vec<RecModel>,
}

static OCR_ENGINE: OnceLock<Result<OcrEngine, String>> = OnceLock::new();

fn get_or_init_engine() -> Result<&'static OcrEngine, String> {
    let result = OCR_ENGINE.get_or_init(init_engine);
    match result {
        Ok(engine) => Ok(engine),
        Err(e) => Err(e.clone()),
    }
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

fn init_engine() -> Result<OcrEngine, String> {
    let models_dir = ocr_models_dir();
    fs::create_dir_all(&models_dir)
        .map_err(|e| format!("Failed to create OCR models dir: {e}"))?;

    // Download all models if missing
    let downloads = [
        (DET_MODEL_FILE, DET_MODEL_URL),
        (REC_EN_MODEL_FILE, REC_EN_MODEL_URL),
        (REC_EN_DICT_FILE, REC_EN_DICT_URL),
        (REC_CYR_MODEL_FILE, REC_CYR_MODEL_URL),
        (REC_CYR_DICT_FILE, REC_CYR_DICT_URL),
    ];
    for (file, url) in downloads {
        download_if_missing(&models_dir.join(file), url)?;
    }

    eprintln!("[rag/ocr] Loading detection model...");
    let det_session = load_session(models_dir.join(DET_MODEL_FILE), "det")?;

    eprintln!("[rag/ocr] Loading English/Latin recognition model...");
    let en_session = load_session(models_dir.join(REC_EN_MODEL_FILE), "rec-en")?;
    let en_dict = load_dictionary(models_dir.join(REC_EN_DICT_FILE))?;

    eprintln!("[rag/ocr] Loading Cyrillic recognition model...");
    let cyr_session = load_session(models_dir.join(REC_CYR_MODEL_FILE), "rec-cyr")?;
    let cyr_dict = load_dictionary(models_dir.join(REC_CYR_DICT_FILE))?;

    eprintln!(
        "[rag/ocr] OCR engine initialized (en dict: {}, cyr dict: {})",
        en_dict.len(),
        cyr_dict.len()
    );

    Ok(OcrEngine {
        det_session: Mutex::new(det_session),
        rec_models: vec![
            RecModel {
                session: Mutex::new(en_session),
                dictionary: en_dict,
                name: "en",
            },
            RecModel {
                session: Mutex::new(cyr_session),
                dictionary: cyr_dict,
                name: "cyr",
            },
        ],
    })
}

fn ocr_models_dir() -> PathBuf {
    rag_config::models_dir().join("ocr")
}

// --- Model download ---

fn download_if_missing(path: &Path, url: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown");
    eprintln!("[rag/ocr] Downloading {file_name}...");

    // Use blocking reqwest (we're already in spawn_blocking context)
    let response = reqwest::blocking::get(url)
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
pub fn ocr_pdf(path: &Path) -> Result<String, String> {
    let engine = get_or_init_engine()?;
    let images = pdf_to_images(path)?;

    if images.is_empty() {
        return Err("PDF produced no page images".into());
    }

    let mut all_text = String::new();

    for (page_idx, img) in images.iter().enumerate() {
        match ocr_image(engine, img) {
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
                eprintln!("[rag/ocr] Page {} OCR failed: {e}", page_idx + 1);
            }
        }
    }

    if all_text.trim().is_empty() {
        return Err("OCR produced no text".into());
    }

    Ok(all_text)
}

// --- PDF to images (via pdftoppm) ---

fn pdf_to_images(path: &Path) -> Result<Vec<DynamicImage>, String> {
    let path_str = path.to_str().ok_or("Invalid path encoding")?;
    let tmp_dir = tempfile::tempdir()
        .map_err(|e| format!("Failed to create temp dir: {e}"))?;
    let prefix = tmp_dir.path().join("page");
    let prefix_str = prefix.to_str().ok_or("Invalid temp path")?;

    let output = Command::new("pdftoppm")
        .args(["-r", "300", "-png", path_str, prefix_str])
        .output()
        .map_err(|e| format!("pdftoppm not available: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pdftoppm failed: {stderr}"));
    }

    // Collect generated PNG files sorted by name
    let mut png_files: Vec<PathBuf> = fs::read_dir(tmp_dir.path())
        .map_err(|e| format!("Failed to read temp dir: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("png") {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    png_files.sort();

    let mut images = Vec::with_capacity(png_files.len());
    for png in &png_files {
        let img = image::open(png)
            .map_err(|e| format!("Failed to open page image: {e}"))?;
        images.push(img);
    }

    Ok(images)
}

// --- OCR pipeline for a single image ---

fn ocr_image(engine: &OcrEngine, image: &DynamicImage) -> Result<String, String> {
    // 1. Detect text regions
    let boxes = detect_text(&engine.det_session, image)
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
        let best = recognize_best(&engine.rec_models, &cropped);
        if let Some((ref text, _confidence, _model_name)) = best {
            let trimmed: String = text.trim().to_string();
            if !trimmed.is_empty() {
                lines.push(trimmed);
            }
        }
    }

    Ok(lines.join("\n"))
}

/// Run all recognition models on a cropped image, return (text, confidence, model_name)
/// for the model with highest confidence. Returns None if all models fail or produce empty text.
fn recognize_best<'a>(models: &'a [RecModel], image: &DynamicImage) -> Option<(String, f32, &'a str)> {
    let mut best: Option<(String, f32, &str)> = None;

    for model in models {
        match recognize_text(&model.session, image, &model.dictionary) {
            Ok((text, confidence)) => {
                if text.trim().is_empty() {
                    continue;
                }
                let dominated = match &best {
                    Some((_, best_conf, _)) => confidence > *best_conf,
                    None => true,
                };
                if dominated {
                    best = Some((text, confidence, model.name));
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

fn detect_text(session: &Mutex<Session>, image: &DynamicImage) -> Result<Vec<TextBox>, String> {
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

    let mut session_guard = session
        .lock()
        .map_err(|e| format!("Det session lock poisoned: {e}"))?;
    let outputs = session_guard
        .run(ort::inputs!["x" => input_value])
        .map_err(|e| format!("Detection inference failed: {e}"))?;

    // Output is probability map [1, 1, H, W]
    let output_value = outputs
        .values()
        .next()
        .ok_or("No detection output")?;

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
    session: &Mutex<Session>,
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

    let mut session_guard = session
        .lock()
        .map_err(|e| format!("Rec session lock poisoned: {e}"))?;
    let outputs = session_guard
        .run(ort::inputs!["x" => input_value])
        .map_err(|e| format!("Recognition inference failed: {e}"))?;

    let output_value = outputs
        .values()
        .next()
        .ok_or("No recognition output")?;

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
