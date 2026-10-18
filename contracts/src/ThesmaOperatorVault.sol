// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ThesmaOperatorVault
/// @notice Testnet-only hardened vault: the ThesmaMarketVault budget cage
///         plus onchain operator spending authority (RFB 04).
/// @dev NEVER deploy to Arc mainnet and never replace the audited v1 vault
///      there. This contract exists so the agent/backend cannot talk past
///      human-set spending limits: autonomous payouts are accepted only
///      inside the owner-configured policy, and over-authority payments
///      need an exact, single-use, owner-signed approval.
///
///      EIP-712 domain name is DELIBERATELY "ThesmaMarketVault"/"1" (same as
///      v1): the domain separator still binds chainId + verifyingContract,
///      so proofs cannot replay across contracts, while the backend's
///      existing outcomeProofDomain(chainId, vaultAddress) helper produces
///      valid digests with zero changes. The OutcomePaid event is likewise
///      identical so existing reconciliation keeps working.
///
///      There is intentionally NO generic payoutVerifiedOutcome: every
///      executor payout must pass either the autonomous policy gate or an
///      exact human approval. Amounts are micro-USDC throughout.
///      Reserve accounting uses vault books (funded - spent); offchain
///      reservation commitments are enforced by the backend on top.
contract ThesmaOperatorVault is EIP712("ThesmaMarketVault", "1"), ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Arc USDC token. Immutable; no other asset is ever accepted.
    IERC20 public immutable USDC;

    struct Campaign {
        address owner;
        bytes32 policyHash;
        uint256 budgetCap;
        uint256 bountyCeiling;
        uint64 deadline;
        address executor;
        address verifier;
        uint256 funded;
        uint256 spent;
        bool paused;
        bool closed;
        bool returned;
    }

    /// @notice Human-set autonomous spending authority for one campaign.
    /// @dev periodSpendCap == 0 means "no period cap" (per-payment cap and
    ///      reserve still bind every payout). periodDuration == 0 means the
    ///      first period never rolls over. enabled == false rejects every
    ///      autonomous payout (fail closed when unconfigured).
    struct OperatorPolicy {
        uint256 minReserve;
        uint256 maxAutonomousPayment;
        uint256 periodSpendCap;
        uint64 periodDuration;
        uint64 periodStart;
        uint256 spentInPeriod;
        bool enabled;
    }

    mapping(bytes32 => Campaign) private _campaigns;
    mapping(bytes32 => OperatorPolicy) private _operatorPolicies;
    mapping(bytes32 => bool) private _usedOutcomes;
    mapping(bytes32 => bool) private _usedProofs;
    /// @notice Single-use human approvals, keyed by the exact obligation.
    mapping(bytes32 => bool) private _approvedObligations;

    bytes32 private constant OUTCOME_TYPEHASH = keccak256(
        "OutcomeProof(bytes32 campaignKey,bytes32 policyHash,bytes32 outcomeId,address recipient,uint256 amount,bytes32 proofHash,uint64 occurredAt,uint64 validUntil)"
    );

    event CampaignCreated(
        bytes32 indexed campaignKey,
        address indexed owner,
        bytes32 policyHash,
        uint256 budgetCap,
        uint256 bountyCeiling,
        uint64 deadline,
        address executor,
        address verifier
    );
    event CampaignFunded(bytes32 indexed campaignKey, address indexed funder, uint256 amount, uint256 totalFunded);
    event CampaignPaused(bytes32 indexed campaignKey);
    event CampaignClosed(bytes32 indexed campaignKey);
    event UnspentReturned(bytes32 indexed campaignKey, address indexed owner, uint256 amount);
    event OutcomePaid(
        bytes32 indexed campaignKey,
        bytes32 policyHash,
        bytes32 indexed outcomeId,
        address indexed recipient,
        uint256 amount,
        bytes32 proofHash
    );
    event OperatorPolicyUpdated(
        bytes32 indexed campaignKey,
        uint256 minReserve,
        uint256 maxAutonomousPayment,
        uint256 periodSpendCap,
        uint64 periodDuration,
        bool enabled
    );
    event ObligationApproved(
        bytes32 indexed campaignKey,
        bytes32 indexed outcomeId,
        address indexed recipient,
        uint256 amount,
        bytes32 proofHash
    );
    event ApprovedObligationConsumed(bytes32 indexed campaignKey, bytes32 indexed outcomeId);

    error ZeroUsdc();
    error CampaignExists();
    error UnknownCampaign();
    error ZeroPolicyHash();
    error ZeroBudgetCap();
    error ZeroBountyCeiling();
    error BadDeadline();
    error ZeroExecutor();
    error ZeroVerifier();
    error NotOwner();
    error NotExecutor();
    error Paused();
    error Closed();
    error NotClosed();
    error ZeroAmount();
    error OverBudgetCap();
    error FundingAfterDeadline();
    error ZeroRecipient();
    error OverBountyCeiling();
    error InsufficientFunded();
    error OutcomeReplay();
    error ProofReplay();
    error BadSignature();
    error OutcomeAfterDeadline();
    error ProofExpired();
    error AlreadyReturned();
    error NothingToReturn();
    error OperatorPolicyNotConfigured();
    error OverAutonomousPayment();
    error OverPeriodSpend();
    error ReserveViolation();
    error NotApproved();

    constructor(address usdc) {
        if (usdc == address(0)) revert ZeroUsdc();
        USDC = IERC20(usdc);
    }

    /// @notice Register a campaign budget cage. Caller becomes the owner.
    function createCampaign(
        bytes32 campaignKey,
        bytes32 policyHash,
        uint256 budgetCap,
        uint256 bountyCeiling,
        uint64 deadline,
        address executor,
        address verifier
    ) external {
        if (_campaigns[campaignKey].owner != address(0)) revert CampaignExists();
        if (policyHash == bytes32(0)) revert ZeroPolicyHash();
        if (budgetCap == 0) revert ZeroBudgetCap();
        if (bountyCeiling == 0) revert ZeroBountyCeiling();
        if (deadline <= block.timestamp) revert BadDeadline();
        if (executor == address(0)) revert ZeroExecutor();
        if (verifier == address(0)) revert ZeroVerifier();

        _campaigns[campaignKey] = Campaign({
            owner: msg.sender,
            policyHash: policyHash,
            budgetCap: budgetCap,
            bountyCeiling: bountyCeiling,
            deadline: deadline,
            executor: executor,
            verifier: verifier,
            funded: 0,
            spent: 0,
            paused: false,
            closed: false,
            returned: false
        });

        emit CampaignCreated(
            campaignKey, msg.sender, policyHash, budgetCap, bountyCeiling, deadline, executor, verifier
        );
    }

    /// @notice Owner funds the campaign from Arc USDC via transferFrom.
    function fundCampaign(bytes32 campaignKey, uint256 amount) external nonReentrant {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        if (c.closed) revert Closed();
        if (c.paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > c.deadline) revert FundingAfterDeadline();
        if (c.funded + amount > c.budgetCap) revert OverBudgetCap();

        c.funded += amount;
        USDC.safeTransferFrom(msg.sender, address(this), amount);

        emit CampaignFunded(campaignKey, msg.sender, amount, c.funded);
    }

    /// @notice Owner pauses new funding and payouts. One-way.
    function pauseCampaign(bytes32 campaignKey) external {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        if (c.closed) revert Closed();
        c.paused = true;
        emit CampaignPaused(campaignKey);
    }

    /// @notice Owner closes the campaign. Deterministically rejects repeats.
    function closeCampaign(bytes32 campaignKey) external {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        if (c.closed) revert Closed();
        c.closed = true;
        emit CampaignClosed(campaignKey);
    }

    /// @notice Owner recovers exactly funded - spent after close. Exactly once.
    function returnUnspent(bytes32 campaignKey) external nonReentrant {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        if (!c.closed) revert NotClosed();
        if (c.returned) revert AlreadyReturned();
        uint256 amount = c.funded - c.spent;
        if (amount == 0) revert NothingToReturn();

        c.returned = true;
        USDC.safeTransfer(c.owner, amount);

        emit UnspentReturned(campaignKey, c.owner, amount);
    }

    /// @notice Owner sets the autonomous spending authority. Executor/agent
    ///         can never call this: only the campaign owner. A fresh window
    ///         starts now with zero spent. Emitted for backend indexing.
    function setOperatorPolicy(
        bytes32 campaignKey,
        uint256 minReserve,
        uint256 maxAutonomousPayment,
        uint256 periodSpendCap,
        uint64 periodDuration
    ) external {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        if (maxAutonomousPayment == 0) revert ZeroAmount();
        _operatorPolicies[campaignKey] = OperatorPolicy({
            minReserve: minReserve,
            maxAutonomousPayment: maxAutonomousPayment,
            periodSpendCap: periodSpendCap,
            periodDuration: periodDuration,
            periodStart: uint64(block.timestamp),
            spentInPeriod: 0,
            enabled: true
        });
        emit OperatorPolicyUpdated(
            campaignKey, minReserve, maxAutonomousPayment, periodSpendCap, periodDuration, true
        );
    }

    /// @notice Owner disables autonomous payouts. Fail-closed by default.
    function disableOperatorPolicy(bytes32 campaignKey) external {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        _operatorPolicies[campaignKey].enabled = false;
        OperatorPolicy storage p = _operatorPolicies[campaignKey];
        emit OperatorPolicyUpdated(
            campaignKey, p.minReserve, p.maxAutonomousPayment, p.periodSpendCap, p.periodDuration, false
        );
    }

    /// @notice EIP-712 digest for an outcome proof. Exposed for off-chain signing.
    function outcomeDigest(
        bytes32 campaignKey,
        bytes32 policyHash,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash,
        uint64 occurredAt,
        uint64 validUntil
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OUTCOME_TYPEHASH,
                    campaignKey,
                    policyHash,
                    outcomeId,
                    recipient,
                    amount,
                    proofHash,
                    occurredAt,
                    validUntil
                )
            )
        );
    }

    /// @notice Owner approves ONE exact obligation for a single human-approved
    ///         payout. Bypasses OPERATOR caps only — never budget, ceiling,
    ///         proof, deadline, or replay checks (those re-run at payout).
    function approveObligation(
        bytes32 campaignKey,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash
    ) external {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.owner) revert NotOwner();
        if (recipient == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();
        bytes32 approvalKey = _approvalKey(campaignKey, outcomeId, recipient, amount, proofHash);
        _approvedObligations[approvalKey] = true;
        emit ObligationApproved(campaignKey, outcomeId, recipient, amount, proofHash);
    }

    function _approvalKey(
        bytes32 campaignKey,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(campaignKey, outcomeId, recipient, amount, proofHash));
    }

    /// @notice Settle one verified outcome inside autonomous authority.
    /// @dev Policy gates run BEFORE effects (fail closed). CEI ordering:
    ///      state updates precede transfer.
    function payoutAutonomous(
        bytes32 campaignKey,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash,
        uint64 occurredAt,
        uint64 validUntil,
        bytes calldata signature
    ) external nonReentrant {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.executor) revert NotExecutor();
        OperatorPolicy storage p = _operatorPolicies[campaignKey];
        if (!p.enabled) revert OperatorPolicyNotConfigured();
        if (amount > p.maxAutonomousPayment) revert OverAutonomousPayment();
        _rollPeriod(p);
        if (p.periodSpendCap > 0 && p.spentInPeriod + amount > p.periodSpendCap) revert OverPeriodSpend();
        _checkPayoutValidity(c, outcomeId, recipient, amount, proofHash, occurredAt, validUntil);
        if (c.funded - c.spent - amount < p.minReserve) revert ReserveViolation();

        _settle(c, campaignKey, outcomeId, recipient, amount, proofHash, occurredAt, validUntil, signature);
        p.spentInPeriod += amount;
    }

    /// @notice Settle one human-approved obligation. Consumes the exact
    ///         approval: same parameters twice always revert the second time.
    function payoutApproved(
        bytes32 campaignKey,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash,
        uint64 occurredAt,
        uint64 validUntil,
        bytes calldata signature
    ) external nonReentrant {
        Campaign storage c = _campaigns[campaignKey];
        if (c.owner == address(0)) revert UnknownCampaign();
        if (msg.sender != c.executor) revert NotExecutor();
        bytes32 approvalKey = _approvalKey(campaignKey, outcomeId, recipient, amount, proofHash);
        if (!_approvedObligations[approvalKey]) revert NotApproved();
        _checkPayoutValidity(c, outcomeId, recipient, amount, proofHash, occurredAt, validUntil);

        _approvedObligations[approvalKey] = false;
        _settle(c, campaignKey, outcomeId, recipient, amount, proofHash, occurredAt, validUntil, signature);
        emit ApprovedObligationConsumed(campaignKey, outcomeId);
    }

    function _rollPeriod(OperatorPolicy storage p) internal {
        if (p.periodDuration > 0 && block.timestamp >= p.periodStart + p.periodDuration) {
            p.periodStart = uint64(block.timestamp);
            p.spentInPeriod = 0;
        }
    }

    /// @dev Shared economic + proof validity. Operator caps are NOT checked
    ///      here: callers gate those before invoking this.
    function _checkPayoutValidity(
        Campaign storage c,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash,
        uint64 occurredAt,
        uint64 validUntil
    ) internal view {
        if (c.paused) revert Paused();
        if (c.closed) revert Closed();
        if (recipient == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();
        if (amount > c.bountyCeiling) revert OverBountyCeiling();
        if (c.spent + amount > c.funded) revert InsufficientFunded();
        if (_usedOutcomes[outcomeId]) revert OutcomeReplay();
        if (_usedProofs[proofHash]) revert ProofReplay();
        if (occurredAt > c.deadline) revert OutcomeAfterDeadline();
        if (validUntil < block.timestamp) revert ProofExpired();
    }

    function _settle(
        Campaign storage c,
        bytes32 campaignKey,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash,
        uint64 occurredAt,
        uint64 validUntil,
        bytes calldata signature
    ) internal {
        _usedOutcomes[outcomeId] = true;
        _usedProofs[proofHash] = true;
        c.spent += amount;
        USDC.safeTransfer(recipient, amount);

        emit OutcomePaid(campaignKey, c.policyHash, outcomeId, recipient, amount, proofHash);
    }

    /// @notice Read-only campaign record for backends and reconcilers.
    function getCampaign(bytes32 campaignKey) external view returns (Campaign memory) {
        return _campaigns[campaignKey];
    }

    /// @notice Read-only operator policy for backends and UIs.
    function getOperatorPolicy(bytes32 campaignKey) external view returns (OperatorPolicy memory) {
        return _operatorPolicies[campaignKey];
    }

    function isApproved(
        bytes32 campaignKey,
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash
    ) external view returns (bool) {
        return _approvedObligations[_approvalKey(campaignKey, outcomeId, recipient, amount, proofHash)];
    }

    function outcomeUsed(bytes32 outcomeId) external view returns (bool) {
        return _usedOutcomes[outcomeId];
    }

    function proofUsed(bytes32 proofHash) external view returns (bool) {
        return _usedProofs[proofHash];
    }

    /// @dev No generic withdrawal path exists by construction. The only
    ///      outbound transfers are the exact-recipient payouts and the exact
    ///      owner-only unspent return above.
}
