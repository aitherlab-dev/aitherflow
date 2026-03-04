use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;

use super::WebState;

/// WebSocket upgrade handler. Streams CLI events to the browser client.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<WebState>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<WebState>) {
    let mut rx = state.event_tx.subscribe();

    loop {
        tokio::select! {
            // Forward CLI events to the browser
            event = rx.recv() => {
                match event {
                    Ok(cli_event) => {
                        let msg = serde_json::json!({
                            "channel": "cli-event",
                            "payload": cli_event
                        });
                        if let Ok(text) = serde_json::to_string(&msg) {
                            let send_result: Result<(), axum::Error> = socket.send(Message::Text(text.into())).await;
                            if send_result.is_err() {
                                break; // Client disconnected
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[ws] Dropped {n} events (client too slow)");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break; // Channel closed
                    }
                }
            }
            // Handle incoming messages from client (ping/pong, close)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    _ => {} // Ignore text/binary from client for now
                }
            }
        }
    }
}
