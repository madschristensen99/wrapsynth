use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use alloy::primitives::Address;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::db::Database;
use crate::evm::EvmClient;
use crate::monero::MoneroClient;
use crate::oracle::OracleClient;
use crate::quote::QuoteGenerator;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct ApiConfig {
    pub port: u16,
    pub admin_secret: String,
    pub quote_ttl_seconds: u64,
    pub min_xmr_amount: u64,
    pub max_xmr_amount: u64,
    pub mint_fee_bps: u16,
    pub burn_reward_bps: u16,
    pub griefing_deposit_wei: String,
    pub mint_ready_bond_wei: String,
}

#[derive(Clone)]
pub struct ApiState {
    pub db: Arc<Database>,
    pub evm: Arc<EvmClient>,
    pub monero: Arc<MoneroClient>,
    pub oracle: Arc<OracleClient>,
    pub quote_gen: Arc<QuoteGenerator>,
    pub config: ApiConfig,
    pub lp_vault: Address,
    pub start_time: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
}

pub async fn start_api_server(
    db: Arc<Database>,
    evm: Arc<EvmClient>,
    monero: Arc<MoneroClient>,
    oracle: Arc<OracleClient>,
    quote_gen: Arc<QuoteGenerator>,
    config: ApiConfig,
    lp_vault: Address,
) -> anyhow::Result<()> {
    let start_time = current_timestamp();
    
    let state = ApiState {
        db,
        evm,
        monero,
        oracle,
        quote_gen,
        config: config.clone(),
        lp_vault,
        start_time,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/swap/:request_id", get(get_swap_info))
        .route("/lp/info", get(lp_info))
        .route("/quote/mint", post(quote_mint))
        .route("/quote/burn", post(quote_burn))
        .route("/mint/notify", post(mint_notify))
        .route("/mint/:request_id/status", get(mint_status))
        .route("/burn/:request_id/status", get(burn_status))
        .route("/admin/start", post(admin_start))
        .route("/admin/pause", post(admin_pause))
        .route("/admin/inventory", get(admin_inventory))
        .route("/admin/oracle/status", get(admin_oracle_status))
        .route("/admin/oracle/force_push", post(admin_oracle_force_push))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    info!("Starting API server on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn health_check() -> &'static str {
    "OK"
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

async fn get_swap_info(
    State(state): State<ApiState>,
    Path(request_id): Path<String>,
) -> Result<Json<SwapInfoResponse>, (StatusCode, Json<ErrorResponse>)> {
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

#[derive(Debug, Serialize)]
struct LpInfoResponse {
    lp_address: String,
    lp_vault: String,
    monero_network: String,
    supported_collateral: Vec<String>,
    quote_ttl_seconds: u64,
    min_xmr_amount: u64,
    max_xmr_amount: u64,
    current_capacity_xmr: u64,
    mint_fee_bps: u16,
    burn_reward_bps: u16,
    griefing_deposit_wei: String,
    mint_ready_bond_wei: String,
    node_version: String,
    uptime_seconds: u64,
}

async fn lp_info(
    State(state): State<ApiState>,
) -> Result<Json<LpInfoResponse>, (StatusCode, Json<ErrorResponse>)> {
    let current_time = current_timestamp();
    let active_quotes = state.db.get_active_quotes(current_time).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Database error: {}", e),
            }),
        )
    })?;

    let total_quote_holds: u64 = active_quotes.iter().map(|q| q.xmr_amount).sum();

    let capacity = state.evm.get_lp_capacity(total_quote_holds).await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to calculate capacity: {}", e),
            }),
        )
    })?;

    let vault_info = state.evm.get_vault().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get vault info: {}", e),
            }),
        )
    })?;

    Ok(Json(LpInfoResponse {
        lp_address: format!("{:?}", vault_info.lp_address),
        lp_vault: format!("{:?}", state.lp_vault),
        monero_network: "mainnet".to_string(),
        supported_collateral: vec!["sDAI".to_string()],
        quote_ttl_seconds: state.config.quote_ttl_seconds,
        min_xmr_amount: state.config.min_xmr_amount,
        max_xmr_amount: state.config.max_xmr_amount,
        current_capacity_xmr: capacity,
        mint_fee_bps: state.config.mint_fee_bps,
        burn_reward_bps: state.config.burn_reward_bps,
        griefing_deposit_wei: state.config.griefing_deposit_wei.clone(),
        mint_ready_bond_wei: state.config.mint_ready_bond_wei.clone(),
        node_version: "0.2.0".to_string(),
        uptime_seconds: current_time - state.start_time,
    }))
}

#[derive(Debug, Deserialize)]
struct QuoteMintRequest {
    xmr_amount: u64,
    user_address: String,
}

#[derive(Debug, Serialize)]
struct QuoteResponse {
    quote_id: String,
    lp_vault: String,
    xmr_amount: u64,
    wsxmr_amount: u64,
    fee_wsxmr: u64,
    griefing_deposit_wei: String,
    expires_at: u64,
    signature: String,
}

async fn quote_mint(
    State(state): State<ApiState>,
    Json(req): Json<QuoteMintRequest>,
) -> Result<Json<QuoteResponse>, (StatusCode, Json<ErrorResponse>)> {
    if req.xmr_amount < state.config.min_xmr_amount || req.xmr_amount > state.config.max_xmr_amount {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!(
                    "XMR amount must be between {} and {}",
                    state.config.min_xmr_amount, state.config.max_xmr_amount
                ),
            }),
        ));
    }

    let user: Address = req.user_address.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid user address: {}", e),
            }),
        )
    })?;

    let prices = state.oracle.fetch_redstone_prices().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to fetch prices: {}", e),
            }),
        )
    })?;

    let quote = state
        .quote_gen
        .generate_mint_quote(
            user,
            req.xmr_amount,
            prices.xmr_price,
            state.config.mint_fee_bps,
            state.config.quote_ttl_seconds,
        )
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to generate quote: {}", e),
                }),
            )
        })?;

    state.db.insert_quote(&quote).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to save quote: {}", e),
            }),
        )
    })?;

    Ok(Json(QuoteResponse {
        quote_id: hex::encode(quote.quote_id),
        lp_vault: format!("{:?}", state.lp_vault),
        xmr_amount: quote.xmr_amount,
        wsxmr_amount: quote.wsxmr_amount,
        fee_wsxmr: quote.fee,
        griefing_deposit_wei: state.config.griefing_deposit_wei.clone(),
        expires_at: quote.expires_at,
        signature: hex::encode(quote.signature.unwrap_or_default()),
    }))
}

#[derive(Debug, Deserialize)]
struct QuoteBurnRequest {
    wsxmr_amount: u64,
    user_address: String,
}

async fn quote_burn(
    State(state): State<ApiState>,
    Json(req): Json<QuoteBurnRequest>,
) -> Result<Json<QuoteResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user: Address = req.user_address.parse().map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid user address: {}", e),
            }),
        )
    })?;

    let prices = state.oracle.fetch_redstone_prices().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to fetch prices: {}", e),
            }),
        )
    })?;

    let quote = state
        .quote_gen
        .generate_burn_quote(
            user,
            req.wsxmr_amount,
            prices.xmr_price,
            state.config.burn_reward_bps,
            state.config.quote_ttl_seconds,
        )
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to generate quote: {}", e),
                }),
            )
        })?;

    state.db.insert_quote(&quote).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to save quote: {}", e),
            }),
        )
    })?;

    Ok(Json(QuoteResponse {
        quote_id: hex::encode(quote.quote_id),
        lp_vault: format!("{:?}", state.lp_vault),
        xmr_amount: quote.xmr_amount,
        wsxmr_amount: quote.wsxmr_amount,
        fee_wsxmr: quote.fee,
        griefing_deposit_wei: state.config.griefing_deposit_wei.clone(),
        expires_at: quote.expires_at,
        signature: hex::encode(quote.signature.unwrap_or_default()),
    }))
}

#[derive(Debug, Deserialize)]
struct MintNotifyRequest {
    request_id: String,
    tx_hash: String,
}

#[derive(Debug, Serialize)]
struct MintNotifyResponse {
    request_id: String,
    deposit_address: String,
    xmr_amount: u64,
    status: String,
}

async fn mint_notify(
    State(state): State<ApiState>,
    Json(req): Json<MintNotifyRequest>,
) -> Result<Json<MintNotifyResponse>, (StatusCode, Json<ErrorResponse>)> {
    let request_id_bytes = hex::decode(&req.request_id).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid request ID: {}", e),
            }),
        )
    })?;

    let mut request_id_array = [0u8; 32];
    request_id_array.copy_from_slice(&request_id_bytes);

    let tx_hash_bytes = hex::decode(req.tx_hash.trim_start_matches("0x")).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid tx hash: {}", e),
            }),
        )
    })?;

    let mut tx_hash_array = [0u8; 32];
    tx_hash_array.copy_from_slice(&tx_hash_bytes);

    let verified = state
        .evm
        .verify_mint_event_in_tx(tx_hash_array.into(), request_id_array)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to verify transaction: {}", e),
                }),
            )
        })?;

    if !verified {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "MintInitiated event not found in transaction".to_string(),
            }),
        ));
    }

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
                error: "Mint request not found (event listener may not have processed it yet)".to_string(),
            }),
        )
    })?;

    let deposit_address = task.deposit_address.ok_or_else(|| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Deposit address not generated yet".to_string(),
            }),
        )
    })?;

    Ok(Json(MintNotifyResponse {
        request_id: hex::encode(task.request_id),
        deposit_address,
        xmr_amount: task.xmr_amount,
        status: format!("{:?}", task.status),
    }))
}

#[derive(Debug, Serialize)]
struct MintStatusResponse {
    request_id: String,
    status: String,
    xmr_amount: u64,
    wsxmr_amount: u64,
    deposit_address: Option<String>,
    monero_confirmations: Option<u64>,
}

async fn mint_status(
    State(state): State<ApiState>,
    Path(request_id): Path<String>,
) -> Result<Json<MintStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let request_id_bytes = hex::decode(&request_id).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid request ID: {}", e),
            }),
        )
    })?;

    let mut request_id_array = [0u8; 32];
    request_id_array.copy_from_slice(&request_id_bytes);

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

    Ok(Json(MintStatusResponse {
        request_id: hex::encode(task.request_id),
        status: format!("{:?}", task.status),
        xmr_amount: task.xmr_amount,
        wsxmr_amount: task.wsxmr_amount,
        deposit_address: task.deposit_address,
        monero_confirmations: None,
    }))
}

#[derive(Debug, Serialize)]
struct BurnStatusResponse {
    request_id: String,
    status: String,
    xmr_amount: u64,
    wsxmr_amount: u64,
    monero_txid: Option<String>,
}

async fn burn_status(
    State(state): State<ApiState>,
    Path(request_id): Path<String>,
) -> Result<Json<BurnStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    let request_id_bytes = hex::decode(&request_id).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!("Invalid request ID: {}", e),
            }),
        )
    })?;

    let mut request_id_array = [0u8; 32];
    request_id_array.copy_from_slice(&request_id_bytes);

    let task = state.db.get_burn_task(&request_id_array).map_err(|e| {
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
                error: "Burn request not found".to_string(),
            }),
        )
    })?;

    Ok(Json(BurnStatusResponse {
        request_id: hex::encode(task.request_id),
        status: format!("{:?}", task.status),
        xmr_amount: task.xmr_amount,
        wsxmr_amount: task.wsxmr_amount,
        monero_txid: task.monero_lock_txid,
    }))
}

fn verify_admin_auth(headers: &HeaderMap, secret: &str) -> Result<(), (StatusCode, Json<ErrorResponse>)> {
    let auth_header = headers.get("X-Admin-Key").ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Missing X-Admin-Key header".to_string(),
            }),
        )
    })?;

    let provided_key = auth_header.to_str().map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Invalid X-Admin-Key header".to_string(),
            }),
        )
    })?;

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Failed to create HMAC".to_string(),
            }),
        )
    })?;
    mac.update(b"admin_auth");
    let expected = hex::encode(mac.finalize().into_bytes());

    if provided_key != expected {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Invalid admin key".to_string(),
            }),
        ));
    }

    Ok(())
}

async fn admin_start(
    State(_state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_admin_auth(&headers, &_state.config.admin_secret)?;
    Ok(Json(serde_json::json!({"status": "running"})))
}

async fn admin_pause(
    State(_state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_admin_auth(&headers, &_state.config.admin_secret)?;
    Ok(Json(serde_json::json!({"status": "paused"})))
}

#[derive(Debug, Serialize)]
struct InventoryResponse {
    xmr_balance: u64,
    xmr_unlocked: u64,
    collateral_amount: String,
    locked_collateral: String,
    pending_mints: usize,
    pending_burns: usize,
    warnings: Vec<String>,
}

async fn admin_inventory(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<InventoryResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_admin_auth(&headers, &state.config.admin_secret)?;

    let (xmr_balance, xmr_unlocked) = state.monero.get_balance().await.unwrap_or((0, 0));

    let vault = state.evm.get_vault().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get vault: {}", e),
            }),
        )
    })?;

    let mints = state.db.get_all_mint_tasks().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Database error: {}", e),
            }),
        )
    })?;

    let burns = state.db.get_all_burn_tasks().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Database error: {}", e),
            }),
        )
    })?;

    let pending_mints = mints.iter().filter(|m| !matches!(m.status, crate::db::MintStatus::Completed | crate::db::MintStatus::Cancelled)).count();
    let pending_burns = burns.iter().filter(|b| !matches!(b.status, crate::db::BurnStatus::Completed | crate::db::BurnStatus::Slashed)).count();

    let mut warnings = Vec::new();
    if xmr_unlocked < 1000000000000 {
        warnings.push("Low XMR balance".to_string());
    }

    Ok(Json(InventoryResponse {
        xmr_balance,
        xmr_unlocked,
        collateral_amount: vault.collateral_shares.to_string(),
        locked_collateral: vault.locked_collateral.to_string(),
        pending_mints,
        pending_burns,
        warnings,
    }))
}

#[derive(Debug, Serialize)]
struct OracleStatusResponse {
    last_xmr_price: u64,
    last_dai_price: u64,
    last_update_timestamp: u64,
    age_seconds: u64,
    last_api_fetch: Option<u64>,
    drift_bps: Option<u16>,
}

async fn admin_oracle_status(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<OracleStatusResponse>, (StatusCode, Json<ErrorResponse>)> {
    verify_admin_auth(&headers, &state.config.admin_secret)?;

    let (xmr_price, timestamp) = state.evm.get_last_oracle_state().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to get oracle state: {}", e),
            }),
        )
    })?;

    let now = current_timestamp();
    let age = now.saturating_sub(timestamp);

    Ok(Json(OracleStatusResponse {
        last_xmr_price: xmr_price,
        last_dai_price: 100000000,
        last_update_timestamp: timestamp,
        age_seconds: age,
        last_api_fetch: None,
        drift_bps: None,
    }))
}

async fn admin_oracle_force_push(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    verify_admin_auth(&headers, &state.config.admin_secret)?;

    let prices = state.oracle.fetch_redstone_prices().await.map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Failed to fetch prices: {}", e),
            }),
        )
    })?;

    let redstone_data = state
        .oracle
        .fetch_redstone_data_packages()
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to fetch RedStone data: {}", e),
                }),
            )
        })?;

    let tx_hash = state
        .evm
        .update_oracle_prices_redstone(redstone_data)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Failed to update prices: {}", e),
                }),
            )
        })?;

    Ok(Json(serde_json::json!({
        "tx_hash": format!("{:?}", tx_hash),
        "xmr_price": prices.xmr_price,
        "dai_price": prices.dai_price,
    })))
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
