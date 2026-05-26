use reqwest::Client;
use serde_json::json;

const TEST_API_URL: &str = "http://localhost:8080";

#[tokio::test]
#[ignore]
async fn test_health_check() {
    let client = Client::new();
    let response = client
        .get(format!("{}/health", TEST_API_URL))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 200);
    let body = response.text().await.expect("Failed to read response");
    assert_eq!(body, "OK");
}

#[tokio::test]
#[ignore]
async fn test_lp_info() {
    let client = Client::new();
    let response = client
        .get(format!("{}/lp/info", TEST_API_URL))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    
    assert!(body.get("lp_address").is_some());
    assert!(body.get("lp_vault").is_some());
    assert!(body.get("current_capacity_xmr").is_some());
    assert!(body.get("mint_fee_bps").is_some());
}

#[tokio::test]
#[ignore]
async fn test_quote_mint() {
    let client = Client::new();
    let response = client
        .post(format!("{}/quote/mint", TEST_API_URL))
        .json(&json!({
            "xmr_amount": 1000000000000u64,
            "user_address": "0x0000000000000000000000000000000000000001"
        }))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 200);
    let body: serde_json::Value = response.json().await.expect("Failed to parse JSON");
    
    assert!(body.get("quote_id").is_some());
    assert!(body.get("xmr_amount").is_some());
    assert!(body.get("wsxmr_amount").is_some());
    assert!(body.get("fee_wsxmr").is_some());
    assert!(body.get("signature").is_some());
}

#[tokio::test]
#[ignore]
async fn test_quote_mint_invalid_amount() {
    let client = Client::new();
    let response = client
        .post(format!("{}/quote/mint", TEST_API_URL))
        .json(&json!({
            "xmr_amount": 100u64,
            "user_address": "0x0000000000000000000000000000000000000001"
        }))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 400);
}

#[tokio::test]
#[ignore]
async fn test_mint_status_not_found() {
    let client = Client::new();
    let request_id = "0000000000000000000000000000000000000000000000000000000000000001";
    let response = client
        .get(format!("{}/mint/{}/status", TEST_API_URL, request_id))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 404);
}

#[tokio::test]
#[ignore]
async fn test_burn_status_not_found() {
    let client = Client::new();
    let request_id = "0000000000000000000000000000000000000000000000000000000000000001";
    let response = client
        .get(format!("{}/burn/{}/status", TEST_API_URL, request_id))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 404);
}

#[tokio::test]
#[ignore]
async fn test_admin_without_auth() {
    let client = Client::new();
    let response = client
        .get(format!("{}/admin/inventory", TEST_API_URL))
        .send()
        .await
        .expect("Failed to send request");

    assert_eq!(response.status(), 401);
}
