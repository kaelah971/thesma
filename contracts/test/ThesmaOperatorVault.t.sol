// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ThesmaOperatorVault} from "../src/ThesmaOperatorVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice RFB 04 contract hardening: onchain operator spending authority.
/// @dev Proves the agent/backend cannot talk past human-set limits, and that
///      over-authority payments need an exact single-use owner approval.
///      Mainnet v1 vault is untouched (its suite still passes unmodified).
contract ThesmaOperatorVaultTest is Test {
    ThesmaOperatorVault vault;
    MockUSDC usdc;

    address owner = address(0xA11CE);
    address executor = address(0xE1EC);
    address partner = address(0xB3375);
    address stranger = address(0xBAD);
    uint256 verifierKey = 0x1234;
    address verifier;

    bytes32 key = keccak256("thesma:op:campaign:1");
    bytes32 policyHash = keccak256("thesma:op:policy:1");
    uint256 budgetCap = 100_000_000; // 100 USDC
    uint256 ceiling = 20_000_000; // 20 USDC max per outcome (above the 10 USDC autonomous cap)
    uint64 deadline;

    uint256 constant MIN_RESERVE = 20_000_000; // 20 USDC stays put
    uint256 constant MAX_PAYMENT = 10_000_000; // 10 USDC per autonomous payout
    uint256 constant PERIOD_CAP = 15_000_000; // 15 USDC per window
    uint64 constant PERIOD = 1 days;

    uint256 constant T0 = 1_000_000;

    function setUp() public {
        vm.warp(T0);
        verifier = vm.addr(verifierKey);
        usdc = new MockUSDC();
        vault = new ThesmaOperatorVault(address(usdc));
        deadline = uint64(T0 + 30 days);
        usdc.mint(owner, 1_000_000_000);

        vm.prank(owner);
        vault.createCampaign(key, policyHash, budgetCap, ceiling, deadline, executor, verifier);
        vm.startPrank(owner);
        usdc.approve(address(vault), budgetCap);
        vault.fundCampaign(key, budgetCap);
        vm.stopPrank();

        vm.prank(owner);
        vault.setOperatorPolicy(key, MIN_RESERVE, MAX_PAYMENT, PERIOD_CAP, PERIOD);
    }

    struct PayoutArgs {
        bytes32 outcomeId;
        address recipient;
        uint256 amount;
        bytes32 proofHash;
        uint64 occurredAt;
        uint64 validUntil;
        bytes sig;
    }

    uint256 private _nonce;

    function _args(uint256 amount) internal view returns (PayoutArgs memory a) {
        a.outcomeId = keccak256(abi.encode("outcome", amount, block.timestamp));
        a.recipient = partner;
        a.amount = amount;
        a.proofHash = keccak256(abi.encode("proof", amount, block.timestamp));
        a.occurredAt = uint64(T0);
        a.validUntil = uint64(block.timestamp + 1 hours);
        bytes32 digest =
            vault.outcomeDigest(key, policyHash, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        a.sig = abi.encodePacked(r, s, v);
    }

    function _distinct(uint256 amount) internal returns (PayoutArgs memory a) {
        _nonce += 1;
        a.outcomeId = keccak256(abi.encode("outcome", amount, _nonce));
        a.recipient = partner;
        a.amount = amount;
        a.proofHash = keccak256(abi.encode("proof", amount, _nonce));
        a.occurredAt = uint64(T0);
        a.validUntil = uint64(block.timestamp + 1 hours);
        bytes32 digest =
            vault.outcomeDigest(key, policyHash, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        a.sig = abi.encodePacked(r, s, v);
    }

    function _autonomous(PayoutArgs memory a) internal returns (bytes memory ret) {
        vm.prank(executor);
        vault.payoutAutonomous(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
        return "";
    }

    function testAutonomousWithinPolicySucceeds() public {
        PayoutArgs memory a = _args(4_000_000);
        _autonomous(a);
        assertEq(usdc.balanceOf(partner), 4_000_000);
        assertEq(vault.getOperatorPolicy(key).spentInPeriod, 4_000_000);
    }

    function testAutonomousOverPerPaymentCapReverts() public {
        PayoutArgs memory a = _args(MAX_PAYMENT + 1);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OverAutonomousPayment.selector);
        vault.payoutAutonomous(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
        assertEq(usdc.balanceOf(partner), 0);
    }

    function testAutonomousOverPeriodCapReverts() public {
        PayoutArgs memory a1 = _args(10_000_000);
        _autonomous(a1);
        PayoutArgs memory a2 = _args(6_000_000);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OverPeriodSpend.selector);
        vault.payoutAutonomous(key, a2.outcomeId, a2.recipient, a2.amount, a2.proofHash, a2.occurredAt, a2.validUntil, a2.sig);
    }

    function testPeriodRolloverResetsSpend() public {
        PayoutArgs memory a1 = _args(10_000_000);
        _autonomous(a1);
        vm.warp(T0 + PERIOD + 1);
        PayoutArgs memory a2 = _args(10_000_000);
        a2.occurredAt = uint64(T0);
        a2.validUntil = uint64(block.timestamp + 1 hours);
        bytes32 digest =
            vault.outcomeDigest(key, policyHash, a2.outcomeId, a2.recipient, a2.amount, a2.proofHash, a2.occurredAt, a2.validUntil);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        a2.sig = abi.encodePacked(r, s, v);
        _autonomous(a2);
        assertEq(usdc.balanceOf(partner), 20_000_000);
    }

    function testAutonomousReserveViolationReverts() public {
        // funded 100, reserve 20: spend down to the floor through eight
        // policy-valid 10 USDC payouts, then prove the next unit reverts.
        vm.prank(owner);
        vault.setOperatorPolicy(key, MIN_RESERVE, 100_000_000, 0, 0);
        for (uint256 i = 0; i < 8; i++) {
            PayoutArgs memory p = _distinct(10_000_000);
            vm.prank(executor);
            vault.payoutAutonomous(key, p.outcomeId, p.recipient, p.amount, p.proofHash, p.occurredAt, p.validUntil, p.sig);
        }
        assertEq(usdc.balanceOf(partner), 80_000_000);
        PayoutArgs memory a = _distinct(1_000_000);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.ReserveViolation.selector);
        vault.payoutAutonomous(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
    }

    function testAutonomousWithoutPolicyReverts() public {
        bytes32 key2 = keccak256("thesma:op:campaign:2");
        vm.prank(owner);
        vault.createCampaign(key2, policyHash, budgetCap, ceiling, deadline, executor, verifier);
        PayoutArgs memory a = _args(1_000_000);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OperatorPolicyNotConfigured.selector);
        vault.payoutAutonomous(key2, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
    }

    function testExistingBudgetAndCeilingStillEnforced() public {
        // Over bounty ceiling: app terms could never authorize this either.
        // (Fresh uncapped policy so the ceiling check — not the operator cap
        // — is what fires.)
        vm.prank(owner);
        vault.setOperatorPolicy(key, 0, 100_000_000, 0, 0);
        PayoutArgs memory over = _args(ceiling + 1);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OverBountyCeiling.selector);
        vault.payoutAutonomous(key, over.outcomeId, over.recipient, over.amount, over.proofHash, over.occurredAt, over.validUntil, over.sig);
    }

    function testOnlyOwnerSetsPolicy() public {
        vm.prank(stranger);
        vm.expectRevert(ThesmaOperatorVault.NotOwner.selector);
        vault.setOperatorPolicy(key, 0, 1, 0, 0);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.NotOwner.selector);
        vault.disableOperatorPolicy(key);
        // Executor (the agent) cannot raise its own cap or lower the reserve.
        ThesmaOperatorVault.OperatorPolicy memory pol = vault.getOperatorPolicy(key);
        assertEq(pol.minReserve, MIN_RESERVE);
        assertEq(pol.maxAutonomousPayment, MAX_PAYMENT);
    }

    // _policyTuple removed: struct return accessed by field name.

    function testExactHumanApprovalExecutesOnce() public {
        PayoutArgs memory a = _args(14_000_000); // over the 10 autonomous cap
        // Autonomous path refuses: backend cannot label it autonomous.
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OverAutonomousPayment.selector);
        vault.payoutAutonomous(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);

        // Owner approves the EXACT obligation.
        vm.prank(owner);
        vault.approveObligation(key, a.outcomeId, a.recipient, a.amount, a.proofHash);
        assertTrue(vault.isApproved(key, a.outcomeId, a.recipient, a.amount, a.proofHash));

        // Executor settles it once through the approved path.
        vm.prank(executor);
        vault.payoutApproved(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
        assertEq(usdc.balanceOf(partner), 14_000_000);
        assertFalse(vault.isApproved(key, a.outcomeId, a.recipient, a.amount, a.proofHash));

        // Replay fails: approval consumed AND outcome/proof marked used.
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.NotApproved.selector);
        vault.payoutApproved(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
    }

    function testApprovalWrongAmountOrOutcomeRejected() public {
        PayoutArgs memory a = _args(14_000_000);
        vm.prank(owner);
        vault.approveObligation(key, a.outcomeId, a.recipient, a.amount, a.proofHash);

        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.NotApproved.selector);
        vault.payoutApproved(key, a.outcomeId, a.recipient, 13_000_000, a.proofHash, a.occurredAt, a.validUntil, a.sig);

        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.NotApproved.selector);
        vault.payoutApproved(key, keccak256("other"), a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
    }

    function testApprovedPathKeepsEconomicAndProofChecks() public {
        // Over-ceiling approval still cannot settle: caps bypass ONLY the
        // operator limits, never budget/ceiling/proof/replay truth.
        PayoutArgs memory a = _args(ceiling + 1_000_000);
        vm.prank(owner);
        vault.approveObligation(key, a.outcomeId, a.recipient, a.amount, a.proofHash);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OverBountyCeiling.selector);
        vault.payoutApproved(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
    }

    function testStrangerCannotApprove() public {
        PayoutArgs memory a = _args(1_000_000);
        vm.prank(stranger);
        vm.expectRevert(ThesmaOperatorVault.NotOwner.selector);
        vault.approveObligation(key, a.outcomeId, a.recipient, a.amount, a.proofHash);
    }

    function testDisabledPolicyRejectsAutonomous() public {
        vm.prank(owner);
        vault.disableOperatorPolicy(key);
        PayoutArgs memory a = _args(1_000_000);
        vm.prank(executor);
        vm.expectRevert(ThesmaOperatorVault.OperatorPolicyNotConfigured.selector);
        vault.payoutAutonomous(key, a.outcomeId, a.recipient, a.amount, a.proofHash, a.occurredAt, a.validUntil, a.sig);
    }
}
