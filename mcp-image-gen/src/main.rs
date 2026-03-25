mod config;
mod mcp;
mod tools;

use config::Config;
use mcp::{JsonRpcRequest, JsonRpcResponse};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use tracing::{error, info};

fn main() {
    // Log to stderr (stdout is reserved for MCP JSON-RPC)
    tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mcp_image_gen=info".parse().unwrap()),
        )
        .init();

    info!("mcp-image-gen server starting");

    let config = Config::load();
    config.ensure_dirs();

    info!(
        models_path = %config.models_path.display(),
        output_path = %config.output_path.display(),
        default_model = %config.default_model,
        "Config loaded"
    );

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                error!("Failed to read stdin: {e}");
                break;
            }
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                error!("Failed to parse request: {e}");
                let resp = JsonRpcResponse::error(
                    Value::Null,
                    -32700,
                    format!("Parse error: {e}"),
                );
                write_response(&mut stdout, &resp);
                continue;
            }
        };

        // Notifications (no id) don't need a response
        let id = match request.id {
            Some(id) => id,
            None => continue,
        };

        let response = match request.method.as_str() {
            "initialize" => handle_initialize(id),
            "notifications/initialized" => continue,
            "tools/list" => handle_tools_list(id),
            "tools/call" => handle_tools_call(id, &request.params, &config),
            method => {
                info!("Unknown method: {method}");
                JsonRpcResponse::error(id, -32601, format!("Method not found: {method}"))
            }
        };

        write_response(&mut stdout, &response);
    }

    info!("mcp-image-gen server shutting down");
}

fn write_response(stdout: &mut io::Stdout, response: &JsonRpcResponse) {
    match serde_json::to_string(response) {
        Ok(json) => {
            if let Err(e) = writeln!(stdout, "{json}") {
                error!("Failed to write response: {e}");
            }
            if let Err(e) = stdout.flush() {
                error!("Failed to flush stdout: {e}");
            }
        }
        Err(e) => {
            error!("Failed to serialize response: {e}");
        }
    }
}

fn handle_initialize(id: Value) -> JsonRpcResponse {
    info!("Client connected (initialize)");

    JsonRpcResponse::success(
        id,
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "mcp-image-gen",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
    )
}

fn handle_tools_list(id: Value) -> JsonRpcResponse {
    JsonRpcResponse::success(
        id,
        json!({
            "tools": [
                {
                    "name": "generate_image",
                    "description": "Generate an image from a text prompt using a local Stable Diffusion / FLUX model. Returns the file path of the generated image.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "prompt": {
                                "type": "string",
                                "description": "Text description of the image to generate"
                            },
                            "negative_prompt": {
                                "type": "string",
                                "description": "What to avoid in the generated image"
                            },
                            "width": {
                                "type": "integer",
                                "description": "Image width in pixels (default from config)"
                            },
                            "height": {
                                "type": "integer",
                                "description": "Image height in pixels (default from config)"
                            },
                            "steps": {
                                "type": "integer",
                                "description": "Number of diffusion steps (default from config)"
                            },
                            "seed": {
                                "type": "integer",
                                "description": "Random seed (-1 for random)"
                            }
                        },
                        "required": ["prompt"]
                    }
                },
                {
                    "name": "list_models",
                    "description": "List available (downloaded) image generation models",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                }
            ]
        }),
    )
}

fn handle_tools_call(id: Value, params: &Value, config: &Config) -> JsonRpcResponse {
    let tool_name = params
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("");

    match tool_name {
        "generate_image" => match tools::generate_image(params, config) {
            Ok(msg) => JsonRpcResponse::tool_result(id, msg),
            Err(e) => JsonRpcResponse::tool_error(id, e),
        },
        "list_models" => match tools::list_models(config) {
            Ok(msg) => JsonRpcResponse::tool_result(id, msg),
            Err(e) => JsonRpcResponse::tool_error(id, e),
        },
        _ => JsonRpcResponse::error(
            id,
            -32602,
            format!("Unknown tool: {tool_name}"),
        ),
    }
}
