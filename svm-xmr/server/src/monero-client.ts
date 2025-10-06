import axios from 'axios';
import { CONFIG } from './config.js';

export class MoneroClient {
  private rpc = axios.create({
    baseURL: CONFIG.MONERO.WALLET_RPC_URL,
    headers: { 'Content-Type': 'application/json' }
  });

  async getBalance(): Promise<string> {
    const response = await this.rpc.post('/', {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_balance'
    });
    return response.data.result.balance;
  }

  async createAddress(label?: string): Promise<string> {
    const response = await this.rpc.post('/', {
      jsonrpc: '2.0',
      id: '0',
      method: 'create_address',
      params: { account_index: 0, label }
    });
    return response.data.result.address;
  }

  async getAddress(): Promise<string> {
    const response = await this.rpc.post('/', {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_address',
      params: { account_index: 0 }
    });
    return response.data.result.address;
  }

  async transfer(destinations: Array<{ address: string; amount: number }>): Promise<string> {
    const response = await this.rpc.post('/', {
      jsonrpc: '2.0',
      id: '0',
      method: 'transfer',
      params: { destinations }
    });
    return response.data.result.tx_hash;
  }

  async getTxKey(txid: string): Promise<string> {
    const response = await this.rpc.post('/', {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_tx_key',
      params: { txid }
    });
    return response.data.result.tx_key;
  }

  async checkTxKey(txid: string, txKey: string, address: string): Promise<boolean> {
    const response = await this.rpc.post('/', {
      jsonrpc: '2.0',
      id: '0',
      method: 'check_tx_key',
      params: { txid, tx_key: txKey, address }
    });
    return response.data.result.received > 0;
  }
}