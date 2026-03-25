use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

use crate::db::Database;

#[derive(Clone)]
pub struct ApiState {
    pub db: Arc<Database>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SwapInfoResponse {
    pub request_id: String,
    pub deposit_address: String,
    pub lp_public_spend: String,
    pub lp_public_view: String,
    pub xmr_amount: u64,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Start the HTTP API server
pub async fn start_api_server(db: Arc<Database>, port: u16) -> anyhow::Result<()> {
    let state = ApiState { db };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/swap/:request_id", get(get_swap_info))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    info!("Starting API server on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Health check endpoint
async fn health_check() -> &'static str {
    "OK"
}

/// Get swap information for a mint request
async fn get_swap_info(
    State(state): State<ApiState>,
    Path(request_id): Path<String>,
) -> Result<Json<SwapInfoResponse>, (StatusCode, Json<ErrorResponse>)> {
    // Parse request ID from hex
    let request_id_bytes = hex::decode(&request_id).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid request ID: {}", e),
            }),
        )
    })?;

    if request_id_bytes.len() != 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Request ID must be 32 bytes".to_string(),
            }),
        ));
    }

    let mut request_id_array = [0u8; 32];
    request_id_array.copy_from_slice(&request_id_bytes);

    // Get mint task from database
    let task = state.db.get_mint_task(&request_id_array).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Database error: {}", e),
            }),
        )
    })?;

    let task = task.ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Mint request not found".to_string(),
            }),
        )
    })?;

    // Extract swap information
    let deposit_address = task.deposit_address.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Swap keys not generated yet".to_string(),
            }),
        )
    })?;

    let lp_public_spend = task.lp_public_spend.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "LP public spend key not available".to_string(),
            }),
        )
    })?;

    let lp_public_view = task.lp_private_view.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "LP private view key not available".to_string(),
            }),
        )
    })?;

    Ok(Json(SwapInfoResponse {
        request_id: hex::encode(task.request_id),
        deposit_address,
        lp_public_spend: hex::encode(lp_public_spend),
        lp_public_view: hex::encode(lp_public_view),
        xmr_amount: task.xmr_amount,
        status: format!("{:?}", task.status),
    }))
}
