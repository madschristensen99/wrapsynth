import { Request, Response } from 'express';
export declare function createUsdcToXmrSwap(req: Request, res: Response): Promise<void>;
export declare function createXmrToUsdcSwap(req: Request, res: Response): Promise<void>;
export declare function recordLockProof(req: Request, res: Response): Promise<void>;
export declare function redeemSwap(req: Request, res: Response): Promise<void>;
export declare function getSwap(req: Request, res: Response): Promise<void>;
