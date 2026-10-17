// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ThesmaMarketVault
/// @notice Non-upgradeable campaign budget cage for Thesma acquisition markets.
/// @dev Holds one campaign's USDC budget. Customer revenue NEVER flows here:
///      customer payments go directly to the company wallet, while this vault
///      only custodies the pre-funded acquisition budget and pays verified
///      Partner outcomes through the bounded executor/verifier path.
///      Amounts are micro-USDC (6-decimal USDC base units) throughout.
contract ThesmaMarketVault is EIP712("ThesmaMarketVault", "1"), ReentrancyGuard {
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

    mapping(bytes32 => Campaign) private _campaigns;
    mapping(bytes32 => bool) private _usedOutcomes;
    mapping(bytes32 => bool) private _usedProofs;

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

    constructor(address usdc) {
        if (usdc == address(0)) revert ZeroUsdc();
        USDC = IERC20(usdc);
    }

    /// @notice Register a campaign budget cage. Caller becomes the owner.
    /// @dev policyHash is immutable after creation: it can never be replaced.
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
    /// @dev Total funded can never exceed budgetCap. Late funding is rejected.
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

    /// @notice Owner pauses new funding and payouts. One-way in S2.
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

    /// @notice Settle one verified outcome to the exact recipient. Executor only.
    /// @dev The outcome may settle AFTER the campaign deadline (refund holds,
    ///      late verification jobs): only the outcome's occurredAt must be
    ///      at/before the deadline. CEI ordering: state updates precede transfer.
    function payoutVerifiedOutcome(
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

        bytes32 digest =
            outcomeDigest(campaignKey, c.policyHash, outcomeId, recipient, amount, proofHash, occurredAt, validUntil);
        if (ECDSA.recover(digest, signature) != c.verifier) revert BadSignature();

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

    function outcomeUsed(bytes32 outcomeId) external view returns (bool) {
        return _usedOutcomes[outcomeId];
    }

    function proofUsed(bytes32 proofHash) external view returns (bool) {
        return _usedProofs[proofHash];
    }

    /// @dev No generic withdrawal path exists by construction. The only
    ///      outbound transfers are the exact-recipient payout and the exact
    ///      owner-only unspent return above.
}
