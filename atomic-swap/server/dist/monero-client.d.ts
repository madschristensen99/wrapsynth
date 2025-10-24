export declare class MoneroClient {
    private rpc;
    getBalance(): Promise<string>;
    createAddress(label?: string): Promise<string>;
    getAddress(): Promise<string>;
    transfer(destinations: Array<{
        address: string;
        amount: number;
    }>): Promise<string>;
    getTxKey(txid: string): Promise<string>;
    checkTxKey(txid: string, txKey: string, address: string): Promise<boolean>;
}
