export const SWAP_CREATOR_ADDRESS = "0x5C9450561e28741c5C76aE863a65AC7215fcAEDc"; // Your contract address
export const SWAP_CREATOR_ABI = [
	{
		"inputs": [
			{
				"components": [
					{
						"internalType": "address payable",
						"name": "owner",
						"type": "address"
					},
					{
						"internalType": "address payable",
						"name": "claimer",
						"type": "address"
					},
					{
						"internalType": "bytes32",
						"name": "claimCommitment",
						"type": "bytes32"
					},
					{
						"internalType": "bytes32",
						"name": "refundCommitment",
						"type": "bytes32"
					},
					{
						"internalType": "uint256",
						"name": "timeout1",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "timeout2",
						"type": "uint256"
					},
					{
						"internalType": "address",
						"name": "asset",
						"type": "address"
					},
					{
						"internalType": "uint256",
						"name": "value",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "nonce",
						"type": "uint256"
					}
				],
				"internalType": "struct SwapCreator.Swap",
				"name": "_swap",
				"type": "tuple"
			},
			{
				"internalType": "bytes32",
				"name": "_secret",
				"type": "bytes32"
			}
		],
		"name": "claim",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"components": [
					{
						"components": [
							{
								"internalType": "address payable",
								"name": "owner",
								"type": "address"
							},
							{
								"internalType": "address payable",
								"name": "claimer",
								"type": "address"
							},
							{
								"internalType": "bytes32",
								"name": "claimCommitment",
								"type": "bytes32"
							},
							{
								"internalType": "bytes32",
								"name": "refundCommitment",
								"type": "bytes32"
							},
							{
								"internalType": "uint256",
								"name": "timeout1",
								"type": "uint256"
							},
							{
								"internalType": "uint256",
								"name": "timeout2",
								"type": "uint256"
							},
							{
								"internalType": "address",
								"name": "asset",
								"type": "address"
							},
							{
								"internalType": "uint256",
								"name": "value",
								"type": "uint256"
							},
							{
								"internalType": "uint256",
								"name": "nonce",
								"type": "uint256"
							}
						],
						"internalType": "struct SwapCreator.Swap",
						"name": "swap",
						"type": "tuple"
					},
					{
						"internalType": "uint256",
						"name": "fee",
						"type": "uint256"
					},
					{
						"internalType": "bytes32",
						"name": "relayerHash",
						"type": "bytes32"
					},
					{
						"internalType": "address",
						"name": "swapCreator",
						"type": "address"
					}
				],
				"internalType": "struct SwapCreator.RelaySwap",
				"name": "_relaySwap",
				"type": "tuple"
			},
			{
				"internalType": "bytes32",
				"name": "_secret",
				"type": "bytes32"
			},
			{
				"internalType": "address payable",
				"name": "_relayer",
				"type": "address"
			},
			{
				"internalType": "uint32",
				"name": "_salt",
				"type": "uint32"
			},
			{
				"internalType": "uint8",
				"name": "v",
				"type": "uint8"
			},
			{
				"internalType": "bytes32",
				"name": "r",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "s",
				"type": "bytes32"
			}
		],
		"name": "claimRelayer",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "InvalidClaimer",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidContractAddress",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidRelayerAddress",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidSecret",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidSignature",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidSwap",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidSwapKey",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidTimeout",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "InvalidValue",
		"type": "error"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "_claimCommitment",
				"type": "bytes32"
			},
			{
				"internalType": "bytes32",
				"name": "_refundCommitment",
				"type": "bytes32"
			},
			{
				"internalType": "address payable",
				"name": "_claimer",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "_timeoutDuration1",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "_timeoutDuration2",
				"type": "uint256"
			},
			{
				"internalType": "address",
				"name": "_asset",
				"type": "address"
			},
			{
				"internalType": "uint256",
				"name": "_value",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "_nonce",
				"type": "uint256"
			}
		],
		"name": "newSwap",
		"outputs": [
			{
				"internalType": "bytes32",
				"name": "",
				"type": "bytes32"
			}
		],
		"stateMutability": "payable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "NotTimeToRefund",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "OnlySwapClaimer",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "OnlySwapOwner",
		"type": "error"
	},
	{
		"inputs": [
			{
				"components": [
					{
						"internalType": "address payable",
						"name": "owner",
						"type": "address"
					},
					{
						"internalType": "address payable",
						"name": "claimer",
						"type": "address"
					},
					{
						"internalType": "bytes32",
						"name": "claimCommitment",
						"type": "bytes32"
					},
					{
						"internalType": "bytes32",
						"name": "refundCommitment",
						"type": "bytes32"
					},
					{
						"internalType": "uint256",
						"name": "timeout1",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "timeout2",
						"type": "uint256"
					},
					{
						"internalType": "address",
						"name": "asset",
						"type": "address"
					},
					{
						"internalType": "uint256",
						"name": "value",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "nonce",
						"type": "uint256"
					}
				],
				"internalType": "struct SwapCreator.Swap",
				"name": "_swap",
				"type": "tuple"
			},
			{
				"internalType": "bytes32",
				"name": "_secret",
				"type": "bytes32"
			}
		],
		"name": "refund",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "token",
				"type": "address"
			}
		],
		"name": "SafeERC20FailedOperation",
		"type": "error"
	},
	{
		"inputs": [
			{
				"components": [
					{
						"internalType": "address payable",
						"name": "owner",
						"type": "address"
					},
					{
						"internalType": "address payable",
						"name": "claimer",
						"type": "address"
					},
					{
						"internalType": "bytes32",
						"name": "claimCommitment",
						"type": "bytes32"
					},
					{
						"internalType": "bytes32",
						"name": "refundCommitment",
						"type": "bytes32"
					},
					{
						"internalType": "uint256",
						"name": "timeout1",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "timeout2",
						"type": "uint256"
					},
					{
						"internalType": "address",
						"name": "asset",
						"type": "address"
					},
					{
						"internalType": "uint256",
						"name": "value",
						"type": "uint256"
					},
					{
						"internalType": "uint256",
						"name": "nonce",
						"type": "uint256"
					}
				],
				"internalType": "struct SwapCreator.Swap",
				"name": "_swap",
				"type": "tuple"
			}
		],
		"name": "setReady",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "SwapAlreadyExists",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "SwapCompleted",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "SwapNotPending",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "TooEarlyToClaim",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "TooLateToClaim",
		"type": "error"
	},
	{
		"inputs": [],
		"name": "ZeroValue",
		"type": "error"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "swapID",
				"type": "bytes32"
			},
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "s",
				"type": "bytes32"
			}
		],
		"name": "Claimed",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "swapID",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "claimKey",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "bytes32",
				"name": "refundKey",
				"type": "bytes32"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "timeout1",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "timeout2",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "address",
				"name": "asset",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "value",
				"type": "uint256"
			}
		],
		"name": "New",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "swapID",
				"type": "bytes32"
			}
		],
		"name": "Ready",
		"type": "event"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "swapID",
				"type": "bytes32"
			},
			{
				"indexed": true,
				"internalType": "bytes32",
				"name": "s",
				"type": "bytes32"
			}
		],
		"name": "Refunded",
		"type": "event"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "scalar",
				"type": "uint256"
			},
			{
				"internalType": "uint256",
				"name": "qKeccak",
				"type": "uint256"
			}
		],
		"name": "mulVerify",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "pure",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "bytes32",
				"name": "",
				"type": "bytes32"
			}
		],
		"name": "swaps",
		"outputs": [
			{
				"internalType": "enum SwapCreator.Stage",
				"name": "",
				"type": "uint8"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
]; // Your contract ABI
export const CHAIN_ID = "0x..."; // Base Sepolia chain ID (e.g., "0x14a34" for 84532)
export const RPC_URL = "https://sepolia.base.org"; // Base Sepolia RPC URL