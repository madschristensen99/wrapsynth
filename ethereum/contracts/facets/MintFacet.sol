// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IMintFacet} from "../interfaces/facets/IMintFacet.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IwsXmrHub} from "../interfaces/core/IwsXmrHub.sol";
import {Ed25519} from "../Ed25519.sol";
import {CollateralLogic} from "../libraries/CollateralLogic.sol";
import {YieldLogic} from "../libraries/YieldLogic.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {GnosisAddresses} from "../GnosisAddresses.sol";

contract MintFacet is wsXmrStorage, IMintFacet {
    
    error ReentrancyGuard();
    
    constructor(address _wsxmrToken, address _verifierProxy) 
        wsXmrStorage(_wsxmrToken, _verifierProxy) 
    {}
    
    function initiateMint(
        address lpVault,
        address recipient,
        uint256 xmrAmount,
        bytes32 claimCommitment
    ) external payable returns (bytes32 requestId) {
        if (lpVault == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroAddress();
        if (xmrAmount == 0) revert ZeroAmount();
        if (claimCommitment == bytes32(0)) revert InvalidCommitment();
        if (!_vaults[lpVault].active) revert VaultDoesNotExist();
        if (xmrAmount < 1e4) revert ZeroAmount();
        
        Vault storage vault = _vaults[lpVault];
        _syncVaultYield(lpVault);
        
        // P0-2: Check griefing deposit requirement
        // Whitelisted minters can bypass; others must meet vault's configured deposit
        bool isWhitelisted = whitelistedMinters[lpVault][msg.sender];
        if (!isWhitelisted) {
            if (vault.mintGriefingDeposit == 0) revert InsufficientDeposit();
            if (msg.value < vault.mintGriefingDeposit) revert InsufficientDeposit();
        }
        
        uint256 wsxmrAmount = xmrAmount / XMR_TO_WSXMR_DIVISOR;
        uint256 feeAmount = (wsxmrAmount * vault.mintFeeBps) / BPS_DENOMINATOR;
        
        if (vault.maxMintBps > 0) {
            uint256 collateralPrice = _getCollateralPriceFromStorage();
            uint256 collateralValueUsd = (vault.collateralShares * collateralPrice) / SDAI_DECIMALS;
            uint256 maxTotalDebtCapacity = (collateralValueUsd * RATIO_PRECISION) / COLLATERAL_RATIO;
            uint256 maxMintAllowed = (maxTotalDebtCapacity * vault.maxMintBps) / BPS_DENOMINATOR;
            
            uint256 xmrPrice = _getXmrPriceFromStorage();
            uint256 wsxmrValueUsd = (wsxmrAmount * xmrPrice) / WSXMR_DECIMALS; // wsXMR has 8 decimals
            
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
        
        uint256 timeoutBlock = block.number + vault.mintTimeoutBlocks;
        mintRequests[requestId] = MintRequest({
            requestId: requestId,
            initiator: msg.sender,
            recipient: recipient,
            lpVault: lpVault,
            xmrAmount: xmrAmount,
            wsxmrAmount: wsxmrAmount,
            feeAmount: feeAmount,
            claimCommitment: claimCommitment,
            timeout: timeoutBlock,
            griefingDeposit: msg.value,
            lpBond: 0,  // Bond posted later when LP calls setMintReady
            normalizedDebtAmount: 0,
            vaultMintNonce: vault.mintNonce,
            status: MintStatus.PENDING
        });
        
        userMintRequests[msg.sender].push(requestId);
        vaultMintRequests[lpVault].push(requestId);
        
        emit MintInitiated(
            requestId,
            msg.sender,
            recipient,
            lpVault,
            xmrAmount,
            wsxmrAmount,
            feeAmount,
            claimCommitment,
            timeoutBlock
        );
    }
    
    /**
     * @notice LP provides their Ed25519 public key for atomic swap coordination
     * @dev User combines LP's public key with their secret to derive shared Monero address
     * @param requestId The mint request ID
     * @param lpPublicKey LP's Ed25519 public key (32 bytes, x-coordinate only)
     */
    function provideLPKey(bytes32 requestId, bytes32 lpPublicKey) external {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.number >= request.timeout) revert DeadlineExpired();
        if (lpPublicKey == bytes32(0)) revert InvalidCommitment();
        if (lpPublicKeys[requestId] != bytes32(0)) revert InvalidStatus(); // Already provided
        
        lpPublicKeys[requestId] = lpPublicKey;
        
        emit LPKeyProvided(requestId, lpPublicKey);
    }
    
    function setMintReady(bytes32 requestId) external payable {
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING) revert InvalidStatus();
        if (msg.sender != request.lpVault) revert Unauthorized();
        if (block.number >= request.timeout) revert DeadlineExpired();
        
        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce != vault.mintNonce) revert InvalidStatus();
        
        // Require LP bond proportional to mint amount
        uint256 requiredBond = vault.mintReadyBond;
        if (msg.value < requiredBond) revert InsufficientBond();
        request.lpBond = msg.value;
        
        _syncVaultYield(request.lpVault);
        
        uint256 actualDebt = IOracleFacet(oracleFacet).denormalizeDebt(vault.normalizedDebt);
        uint256 projectedDebtWithThisMint = actualDebt + request.wsxmrAmount;
        uint256 availableCollateral = vault.collateralShares > vault.lockedCollateral
            ? vault.collateralShares - vault.lockedCollateral
            : 0;
        uint256 currentRatio = _calculateCollateralRatio(availableCollateral, projectedDebtWithThisMint);
        if (currentRatio < COLLATERAL_RATIO) revert InsufficientCollateral();
        
        request.status = MintStatus.READY;
        request.timeout = block.number + MINT_READY_EXTENSION_BLOCKS;
        emit MintReady(requestId);
    }
    
    function finalizeMint(bytes32 requestId, bytes32 secret) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.READY) revert InvalidStatus();
        
        // Verify the secret matches the commitment
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        bytes32 computedCommitment = keccak256(abi.encodePacked(px, py));
        if (computedCommitment != request.claimCommitment) revert InvalidSecret();
        
        Vault storage vault = _vaults[request.lpVault];
        _syncVaultYield(request.lpVault);
        
        if (request.vaultMintNonce != vault.mintNonce) {
            request.status = MintStatus.CANCELLED;
            if (request.griefingDeposit > 0) {
                pendingReturns[request.initiator][address(0)] += request.griefingDeposit;
                emit ReturnQueued(request.initiator, address(0), request.griefingDeposit);
            }
            emit MintCancelled(request.requestId);
            _reentrancyStatus = _NOT_ENTERED;
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
        
        // Return LP bond
        if (request.lpBond > 0) {
            pendingReturns[request.lpVault][address(0)] += request.lpBond;
            emit ReturnQueued(request.lpVault, address(0), request.lpBond);
        }
        
        request.status = MintStatus.COMPLETED;
        emit MintFinalized(requestId, secret);
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function cancelMint(bytes32 requestId) external {
        if (_reentrancyStatus == _ENTERED) revert ReentrancyGuard();
        _reentrancyStatus = _ENTERED;
        
        MintRequest storage request = mintRequests[requestId];
        if (request.status != MintStatus.PENDING && request.status != MintStatus.READY) {
            revert InvalidStatus();
        }
        
        if (block.number < request.timeout) revert TimeoutNotReached();
        
        Vault storage vault = _vaults[request.lpVault];
        if (request.vaultMintNonce == vault.mintNonce) {
            vault.pendingDebt -= request.wsxmrAmount;
        }
        
        MintStatus originalStatus = request.status;
        uint256 depositToTransfer = request.griefingDeposit;
        uint256 bondToTransfer = request.lpBond;
        
        request.status = MintStatus.CANCELLED;
        emit MintCancelled(requestId);
        
        if (originalStatus == MintStatus.PENDING) {
            // Timeout before LP marked ready - user gets griefing deposit back
            if (depositToTransfer > 0) {
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            }
        } else {
            // LP marked READY but failed to provide secret - user gets BOTH deposits
            if (depositToTransfer > 0) {
                pendingReturns[request.initiator][address(0)] += depositToTransfer;
                emit ReturnQueued(request.initiator, address(0), depositToTransfer);
            }
            if (bondToTransfer > 0) {
                pendingReturns[request.initiator][address(0)] += bondToTransfer;
                emit ReturnQueued(request.initiator, address(0), bondToTransfer);
            }
        }
        
        _reentrancyStatus = _NOT_ENTERED;
    }
    
    function getMintRequest(bytes32 requestId) external view returns (MintRequest memory) {
        return mintRequests[requestId];
    }
    
    function getUserMintRequests(address user) external view returns (bytes32[] memory) {
        return userMintRequests[user];
    }
    
    function getVaultPendingMints(address lpVault) external view returns (bytes32[] memory) {
        bytes32[] storage vaultReqs = vaultMintRequests[lpVault];
        uint256 count = 0;
        
        // Count pending/ready requests
        for (uint256 i = 0; i < vaultReqs.length; i++) {
            MintRequest storage req = mintRequests[vaultReqs[i]];
            if (req.status == MintStatus.PENDING || req.status == MintStatus.READY) {
                count++;
            }
        }
        
        // Collect pending/ready requests
        bytes32[] memory result = new bytes32[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < vaultReqs.length; i++) {
            MintRequest storage req = mintRequests[vaultReqs[i]];
            if (req.status == MintStatus.PENDING || req.status == MintStatus.READY) {
                result[index++] = vaultReqs[i];
            }
        }
        
        return result;
    }
    
    function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256) {
        return xmrAmount / XMR_TO_WSXMR_DIVISOR;
    }
    
    function calculateMintFee(address lpVault, uint256 wsxmrAmount) external view returns (uint256) {
        return (wsxmrAmount * _vaults[lpVault].mintFeeBps) / BPS_DENOMINATOR;
    }
    
    
    function _syncVaultYield(address lpAddress) internal {
        Vault storage vault = _vaults[lpAddress];
        
        // Early return if no collateral
        if (vault.collateralShares == 0) return;
        
        // Early return if no debt (skip expensive oracle calls)
        uint256 actualDebt = (vault.normalizedDebt * globalDebtIndex) / 1e18;
        if (actualDebt == 0 && vault.pendingDebt == 0) return;
        
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        
        uint256 yieldShares = YieldLogic.syncVaultYield(
            vault.collateralShares,
            vault.lockedCollateral,
            lpPrincipalShares[lpAddress],
            vault.normalizedDebt,
            vault.pendingDebt,
            globalDebtIndex,
            xmrPrice,
            collateralPrice
        );
        
        if (yieldShares > 0) {
            vault.collateralShares -= yieldShares;
            yieldWarChest += yieldShares;
        }
    }
    
    function _calculateCollateralRatio(uint256 collateralShares, uint256 debtAmount) internal view returns (uint256) {
        // Read prices directly from storage using inherited helpers
        uint256 xmrPrice = _getXmrPriceFromStorage();
        uint256 collateralPrice = _getCollateralPriceFromStorage();
        return CollateralLogic.calculateRatioFromShares(
            collateralShares,
            debtAmount,
            GnosisAddresses.SDAI,
            collateralPrice,
            xmrPrice
        );
    }
    
    // ========== DIAMOND INTROSPECTION ==========
    
    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](9);
        sels[0] = this.initiateMint.selector;
        sels[1] = this.setMintReady.selector;
        sels[2] = this.finalizeMint.selector;
        sels[3] = this.cancelMint.selector;
        sels[4] = this.getMintRequest.selector;
        sels[5] = this.getUserMintRequests.selector;
        sels[6] = this.getVaultPendingMints.selector;
        sels[7] = this.calculateWsxmrAmount.selector;
        sels[8] = this.calculateMintFee.selector;
        return sels;
    }
}
