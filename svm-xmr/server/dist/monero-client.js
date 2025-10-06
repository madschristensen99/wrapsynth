"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MoneroClient = void 0;
const axios_1 = __importDefault(require("axios"));
const config_js_1 = require("./config.js");
class MoneroClient {
    constructor() {
        this.rpc = axios_1.default.create({
            baseURL: config_js_1.CONFIG.MONERO.WALLET_RPC_URL,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    async getBalance() {
        const response = await this.rpc.post('/', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_balance'
        });
        return response.data.result.balance;
    }
    async createAddress(label) {
        const response = await this.rpc.post('/', {
            jsonrpc: '2.0',
            id: '0',
            method: 'create_address',
            params: { account_index: 0, label }
        });
        return response.data.result.address;
    }
    async getAddress() {
        const response = await this.rpc.post('/', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_address',
            params: { account_index: 0 }
        });
        return response.data.result.address;
    }
    async transfer(destinations) {
        const response = await this.rpc.post('/', {
            jsonrpc: '2.0',
            id: '0',
            method: 'transfer',
            params: { destinations }
        });
        return response.data.result.tx_hash;
    }
    async getTxKey(txid) {
        const response = await this.rpc.post('/', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_tx_key',
            params: { txid }
        });
        return response.data.result.tx_key;
    }
    async checkTxKey(txid, txKey, address) {
        const response = await this.rpc.post('/', {
            jsonrpc: '2.0',
            id: '0',
            method: 'check_tx_key',
            params: { txid, tx_key: txKey, address }
        });
        return response.data.result.received > 0;
    }
}
exports.MoneroClient = MoneroClient;
