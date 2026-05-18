// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.19;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IMintFacet} from "../interfaces/facets/IMintFacet.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {Ed25519} from "../Ed25519.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";

contract MintFacet is wsXmrStorage, IMintFacet {
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    function initiateMint(
        address lpVault,
        address recipient,
        uint256 xmrAmount,
        bytes32 claimCommitment,
        uint256 timeoutDuration
    ) external payable returns (bytes32 requestId) {
        if (lpVault == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        if (xmrAmount == 0) revert ZeroAmount();
        if (claimCommitment == bytes32(0)) revert InvalidCommitment();
        if (timeoutDuration == 0 || timeoutDuration > MAX_MINT_TIMEOUT) revert InvalidTimeout();
        if (!vaults[lpVault].active) revert VaultDoesNotExist();
        if (xmrAmount < 1e4) revert ZeroAmount();
        
        Vault storage vault = vaults[lpVault];
        _syncVaultYield(lpVault);
        
        if (msg.value < vault.mintGriefingDeposit) revert InsufficientDeposit();
        
        uint256 wsxmrAmount = xmrAmount / XMR_TO_WSXMR_DIVISOR;
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;
        
        if (vault.maxMintBps > 0) {
            uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
            uint256 collateralValueUsd = (vault.collateralShares * collateralPrice) / SDAI_DECIMALS;
            uint256 maxTotalDebtCapacity = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;
            uint256 maxMintAllowed = (maxTotalDebtCapacity * vault.maxMintBps) / BPS_DENOMINATOR;
            
            uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
            uint256 wsxmrValueUsd = (wsxmrAmount * xmrPrice) / WSXMR_DECIMALS;
            
            if (wsxmrValueUsd > maxMintAllowed) revert InvalidValue();
        }
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 totalProjectedDebt = actualDebt + vault.pendingDebt + wsxmrAmount;
        
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral 
            ? vault.collateralShares - vault.lockedCollateral 
            : 0;
        
        uint256 ratio = _calculateCollateralRatio(availableCollateral, totalProjectedDebt);
        if (ratio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        requestId = keccak256(abi.encodePacked(
            msg.sender,
            lpVault,
            xmrAmount,
            claimCommitment,
            ++_requestNonce
        ));
        
        if (mintRequests[requestId].status != MintStatus.INVALID) revert MintAlreadyExists();
        
        vault.pendingDebt += wsxmrAmount;
        
        mintRequests[requestId] = MintRequest({
            requestId: requestId,
            initiator: msg.sender,
            recipient: recipient,
            lpVault: lpVault,
            xmrAmount: xmrAmount,
            wsxmrAmount: wsxmrAmount,
            feeAmount: feeAmount,
            claimCommitment: claimCommitment,
            timeout: block.timestamp + timeoutDuration,
            griefingDeposit: msg.value,
            normalizedDebtAmount: 0,
            vaultMintNonce: vault.mintNonce,
            status: MintStatus.PENDING
        });
        
        userMintRequests[msg.sender].push(requestId);
        
        emit MintInitiated(
            requestId,
            msg.sender,
            recipient,
            lpVault,
            xmrAmount,
            wsxmrAmount,
            feeAmount,
            claimCommitment,
            block.timestamp + timeoutDuration
        );
    }
    
    function provideLPKey(bytes32 requestId, bytes32 lpPublicKey) external {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (lpPublicKey == bytes32(0)) revert InvalidValue();
        
        lpPublicKeys[requestId] = lpPublicKey;
        emit LPKeyProvided(requestId, lpPublicKey);
    }
    
    function setMintReady(bytes32 requestId) external {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.timestamp >= request.timeout) revert DeadlineExpired();
        
        Vault storage vault = vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();
        
        _syncVaultYield(request.lpVault);
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebtWithThisMint = actualDebt + request.wsxmrAmount;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        uint256 currentRatio = _calculateCollateralRatio(availableCollateral, projectedDebtWithThisMint);
        if (currentRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        request.status = MintStatus.READY;
        request.timeout = block.timestamp + MINT_READY_EXTENSION;
        emit MintReady(requestId);
    }
    
    function finalizeMint(bytes32 requestId, bytes32 secret) external {
        IwsXmrHub(address(this)).enterNonReentrant();
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.READY) revert InvalidStatus();
        
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 computedCommitment = bytes32(keccak256(abi.encodePacked(px, py)));
        if (computedCommitment != request.claimCommitment) revert InvalidSecret();
        
        Vault storage vault = vaults[request.lpVault];
        _syncVaultYield(request.lpVault);
        
        if (request.vaultMintNonce != vault.mintNonce) {
            request.status = MintStatus.CANCELLED;
            if (request.griefingDeposit > 0) {
                pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
                emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
            }
            emit MintCancelled(request.requestId);
            IwsXmrHub(address(this)).exitNonReentrant();
            return;
        }
        
        vault.pendingDebt -= request.wsxmrAmount;
        uint256 normalizedAmount = (request.wsxmrAmount * 1e18 + globalDebtIndex - 1) / globalDebtIndex;
        vault.normalizedDebt += normalizedAmount;
        request.normalizedDebtAmount = normalizedAmount;
        globalTotalDebt += request.wsxmrAmount;
        
        IwsXmrHub(address(this)).mintTokens(request.recipient, request.wsxmrAmount - request.feeAmount);
        if (request.feeAmount > 0) {
            IwsXmrHub(address(this)).mintTokens(vault.lpAddress, request.feeAmount);
        }
        
        if (request.griefingDeposit > 0) {
            pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
            emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
        }
        
        request.status = MintStatus.COMPLETED;
        emit MintFinalized(requestId, secret);
        
        IwsXmrHub(address(this)).exitNonReentrant();
    }
    
    function cancelMint(bytes32 requestId) external {
        IwsXmrHub(address(this)).enterNonReentrant();
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING && request.status != MintStatus.READY) {
            revert InvalidStatus();
        }
        
        if (block.timestamp < request.timeout) revert TimeoutNotReached();
        
        Vault storage vault = vaults[request.lpVault];
        if (request.vaultMintNonce == vault.mintNonce) {
            vault.pendingDebt -= request.wsxmrAmount;
        }
        
        MintStatus originalStatus = request.status;
        uint256 depositToTransfer = request.griefingDeposit;
        
        request.status = MintStatus.CANCELLED;
        emit MintCancelled(requestId);
        
        if (depositToTransfer > 0) {
            if (originalStatus == MintStatus.PENDING) {
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            } else {
                pendingReturns[vault.lpAddress][address(0)] += depositToTransfer;
                emit ReturnQueued(vault.lpAddress, address(0), depositToTransfer);
            }
        }
        
        IwsXmrHub(address(this)).exitNonReentrant();
    }
    
    function getMintRequest(bytes32 requestId) external view returns (MintRequest memory) {
        return mintRequests[requestId];
    }
    
    function getLPPublicKey(bytes32 requestId) external view returns (bytes32) {
        return lpPublicKeys[requestId];
    }
    
    function getUserMintRequests(address user) external view returns (bytes32[] memory) {
        return userMintRequests[user];
    }
    
    function getVaultPendingMints(address lpVault) external view returns (bytes32[] memory) {
        bytes32[] memory allRequests = new bytes32[](userMintRequests[lpVault].length);
        uint256 count = 0;
        for (uint256 i = 0; i < userMintRequests[lpVault].length; i++) {
            bytes32 reqId = userMintRequests[lpVault][i];
            if (mintRequests[reqId].status == MintStatus.PENDING || mintRequests[reqId].status == MintStatus.READY) {
                allRequests[count++] = reqId;
            }
        }
        bytes32[] memory result = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = allRequests[i];
        }
        return result;
    }
    
    function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256) {
        return xmrAmount / XMR_TO_WSXMR_DIVISOR;
    }
    
    function calculateMintFee(address lpVault, uint256 wsxmrAmount) external view returns (uint256) {
        return (wsxmrAmount * vaults[lpVault].mintFeeBps) / BPS_DENOMINATOR;
    }
    
    
    function _syncVaultYield(address lpAddress) internal {
        Vault storage vault = vaults[lpAddress];
        if (vault.collateralShares == 0) return;
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
        
        uint256 yieldShares = YieldLogic.calculateExtractableYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalShares[lpAddress],
            actualDebt,
            vault.pendingDebt,
            xmrPrice,
            collateralPrice
        );
        
        if (yieldShares > 0) {
            vault.collateralShares -= yieldShares;
            yieldWarChest += yieldShares;
        }
    }
    
    function _calculateCollateralRatio(uint256 collateralAmount, uint256 debtAmount) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        uint256 collateralPrice = IOracleFacet(oracleFacet).getCollateralPrice();
        uint256 xmrPrice = IOracleFacet(oracleFacet).getXmrPrice();
        uint256 collateralValueUsd = CollateralLogic.collateralToUsd(collateralAmount, collateralPrice);
        uint256 debtValueUsd = (debtAmount * xmrPrice) / WSXMR_DECIMALS;
        return CollateralLogic.calculateCollateralRatio(collateralValueUsd, debtValueUsd);
    }
}
