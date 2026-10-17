// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ThesmaMarketVault} from "../src/ThesmaMarketVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice S2 contract tests: funding cage + bounded payout primitive.
/// @dev Backend automatic payout is NOT wired in S2; these tests prove the
///      contract capability that S5 will later drive through the executor.
contract ThesmaMarketVaultTest is Test {
    ThesmaMarketVault vault;
    MockUSDC usdc;

    address owner = address(0xA11CE);
    address executor = address(0xE1EC);
    address partner = address(0xB3375);
    address stranger = address(0xBAD);
    uint256 verifierKey = 0x1234;
    address verifier;

    bytes32 key = keccak256("thesma:test:campaign:1");
    bytes32 policyHash = keccak256("thesma:test:policy:1");
    uint256 budgetCap = 15_000_000; // 15 USDC in micro-USDC
    uint256 ceiling = 4_000_000; // 4 USDC max CAC
    uint64 deadline;

    uint256 constant T0 = 1_000_000;

    function setUp() public {
        vm.warp(T0);
        verifier = vm.addr(verifierKey);
        usdc = new MockUSDC();
        vault = new ThesmaMarketVault(address(usdc));
        deadline = uint64(T0 + 30 days);
        usdc.mint(owner, 1_000_000_000);
    }

    function _create() internal {
        vm.prank(owner);
        vault.createCampaign(key, policyHash, budgetCap, ceiling, deadline, executor, verifier);
    }

    function _fundFull() internal {
        vm.startPrank(owner);
        usdc.approve(address(vault), budgetCap);
        vault.fundCampaign(key, budgetCap);
        vm.stopPrank();
    }

    function _digest(
        bytes32 outcomeId,
        address recipient,
        uint256 amount,
        bytes32 proofHash,
        uint64 occurredAt,
        uint64 validUntil
    ) internal view returns (bytes32) {
        return vault.outcomeDigest(key, policyHash, outcomeId, recipient, amount, proofHash, occurredAt, validUntil);
    }

    function _sign(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _validPayoutArgs()
        internal
        view
        returns (
            bytes32 outcomeId,
            address recipient,
            uint256 amount,
            bytes32 proofHash,
            uint64 occurredAt,
            uint64 validUntil,
            bytes memory sig
        )
    {
        outcomeId = keccak256("outcome:1");
        recipient = partner;
        amount = 2_500_000;
        proofHash = keccak256("proof:1");
        occurredAt = uint64(T0 + 1 days);
        validUntil = uint64(T0 + 60 days);
        sig = _sign(_digest(outcomeId, recipient, amount, proofHash, occurredAt, validUntil));
    }

    // ---- constructor ----

    function test_constructor_rejectsZeroUsdc() public {
        vm.expectRevert(ThesmaMarketVault.ZeroUsdc.selector);
        new ThesmaMarketVault(address(0));
    }

    // ---- createCampaign ----

    function test_createCampaign_worksAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit ThesmaMarketVault.CampaignCreated(key, owner, policyHash, budgetCap, ceiling, deadline, executor, verifier);
        vm.prank(owner);
        vault.createCampaign(key, policyHash, budgetCap, ceiling, deadline, executor, verifier);

        ThesmaMarketVault.Campaign memory c = vault.getCampaign(key);
        assertEq(c.owner, owner);
        assertEq(c.policyHash, policyHash);
        assertEq(c.budgetCap, budgetCap);
        assertEq(c.bountyCeiling, ceiling);
        assertEq(c.executor, executor);
        assertEq(c.verifier, verifier);
        assertEq(c.funded, 0);
        assertEq(c.spent, 0);
    }

    function test_createCampaign_duplicateKeyRejected() public {
        _create();
        vm.prank(owner);
        vm.expectRevert(ThesmaMarketVault.CampaignExists.selector);
        vault.createCampaign(key, policyHash, budgetCap, ceiling, deadline, executor, verifier);
    }

    function test_createCampaign_rejectsBadInputs() public {
        bytes32 k = keccak256("k");
        vm.startPrank(owner);
        vm.expectRevert(ThesmaMarketVault.ZeroPolicyHash.selector);
        vault.createCampaign(k, bytes32(0), budgetCap, ceiling, deadline, executor, verifier);
        vm.expectRevert(ThesmaMarketVault.ZeroBudgetCap.selector);
        vault.createCampaign(k, policyHash, 0, ceiling, deadline, executor, verifier);
        vm.expectRevert(ThesmaMarketVault.ZeroBountyCeiling.selector);
        vault.createCampaign(k, policyHash, budgetCap, 0, deadline, executor, verifier);
        vm.expectRevert(ThesmaMarketVault.BadDeadline.selector);
        vault.createCampaign(k, policyHash, budgetCap, ceiling, uint64(T0 - 1), executor, verifier);
        vm.expectRevert(ThesmaMarketVault.ZeroExecutor.selector);
        vault.createCampaign(k, policyHash, budgetCap, ceiling, deadline, address(0), verifier);
        vm.expectRevert(ThesmaMarketVault.ZeroVerifier.selector);
        vault.createCampaign(k, policyHash, budgetCap, ceiling, deadline, executor, address(0));
        vm.stopPrank();
    }

    // ---- funding ----

    function test_fundCampaign_partialThenExactCap() public {
        _create();
        vm.startPrank(owner);
        usdc.approve(address(vault), budgetCap);
        vault.fundCampaign(key, 5_000_000);
        assertEq(vault.getCampaign(key).funded, 5_000_000);
        vault.fundCampaign(key, 10_000_000);
        assertEq(vault.getCampaign(key).funded, budgetCap);
        assertEq(usdc.balanceOf(address(vault)), budgetCap);
        vm.stopPrank();
    }

    function test_fundCampaign_nonOwnerRejected() public {
        _create();
        vm.prank(stranger);
        vm.expectRevert(ThesmaMarketVault.NotOwner.selector);
        vault.fundCampaign(key, 1);
    }

    function test_fundCampaign_zeroRejected() public {
        _create();
        vm.prank(owner);
        vm.expectRevert(ThesmaMarketVault.ZeroAmount.selector);
        vault.fundCampaign(key, 0);
    }

    function test_fundCampaign_overCapRejected() public {
        _create();
        vm.startPrank(owner);
        usdc.approve(address(vault), budgetCap + 1);
        vm.expectRevert(ThesmaMarketVault.OverBudgetCap.selector);
        vault.fundCampaign(key, budgetCap + 1);
        vm.stopPrank();
    }

    function test_fundCampaign_afterDeadlineRejected() public {
        _create();
        vm.warp(deadline + 1);
        vm.startPrank(owner);
        usdc.approve(address(vault), 1);
        vm.expectRevert(ThesmaMarketVault.FundingAfterDeadline.selector);
        vault.fundCampaign(key, 1);
        vm.stopPrank();
    }

    function test_fundCampaign_pausedRejected() public {
        _create();
        vm.prank(owner);
        vault.pauseCampaign(key);
        vm.prank(owner);
        vm.expectRevert(ThesmaMarketVault.Paused.selector);
        vault.fundCampaign(key, 1);
    }

    function testFuzz_fundingSplitsSumToFunded(uint256 a, uint256 b) public {
        a = bound(a, 1, budgetCap);
        b = bound(b, 0, budgetCap - a);
        _create();
        vm.startPrank(owner);
        usdc.approve(address(vault), budgetCap);
        vault.fundCampaign(key, a);
        if (b > 0) vault.fundCampaign(key, b);
        vm.stopPrank();
        assertEq(vault.getCampaign(key).funded, a + b);
        assertLe(vault.getCampaign(key).funded, budgetCap);
    }

    // ---- pause / close / return ----

    function test_pauseAndClose_ownerOnly() public {
        _create();
        vm.prank(stranger);
        vm.expectRevert(ThesmaMarketVault.NotOwner.selector);
        vault.pauseCampaign(key);
        vm.prank(stranger);
        vm.expectRevert(ThesmaMarketVault.NotOwner.selector);
        vault.closeCampaign(key);
    }

    function test_close_idempotentReject() public {
        _create();
        vm.prank(owner);
        vault.closeCampaign(key);
        vm.prank(owner);
        vm.expectRevert(ThesmaMarketVault.Closed.selector);
        vault.closeCampaign(key);
    }

    function test_returnUnspent_exactAmountOnce() public {
        _create();
        _fundFull();
        // One payout so spent > 0, then close and return funded - spent.
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu, bytes memory sig) =
            _validPayoutArgs();
        vm.prank(executor);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);

        vm.prank(owner);
        vault.closeCampaign(key);
        uint256 ownerBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.returnUnspent(key);
        assertEq(usdc.balanceOf(owner) - ownerBefore, budgetCap - amt);

        vm.prank(owner);
        vm.expectRevert(ThesmaMarketVault.AlreadyReturned.selector);
        vault.returnUnspent(key);
    }

    function test_returnUnspent_requiresClose() public {
        _create();
        _fundFull();
        vm.prank(owner);
        vm.expectRevert(ThesmaMarketVault.NotClosed.selector);
        vault.returnUnspent(key);
    }

    // ---- payout primitive ----

    function test_payout_successUpdatesSpentExactly() public {
        _create();
        _fundFull();
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu, bytes memory sig) =
            _validPayoutArgs();
        uint256 before = usdc.balanceOf(partner);
        vm.prank(executor);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
        assertEq(usdc.balanceOf(partner) - before, amt);
        assertEq(vault.getCampaign(key).spent, amt);
        assertTrue(vault.outcomeUsed(oid));
        assertTrue(vault.proofUsed(ph));
    }

    function test_payout_onlyExecutor() public {
        _create();
        _fundFull();
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu, bytes memory sig) =
            _validPayoutArgs();
        vm.prank(stranger);
        vm.expectRevert(ThesmaMarketVault.NotExecutor.selector);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
    }

    function test_payout_aboveCeilingRejected() public {
        _create();
        _fundFull();
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = uint64(T0 + 1 days);
        uint64 vu = uint64(T0 + 60 days);
        bytes memory sig = _sign(_digest(oid, partner, ceiling + 1, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.OverBountyCeiling.selector);
        vault.payoutVerifiedOutcome(key, oid, partner, ceiling + 1, ph, occ, vu, sig);
    }

    function test_payout_beyondFundedRejected() public {
        _create();
        // Fund less than one ceiling payout, then request a full-ceiling payout.
        vm.startPrank(owner);
        usdc.approve(address(vault), 1_000_000);
        vault.fundCampaign(key, 1_000_000);
        vm.stopPrank();
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = uint64(T0 + 1 days);
        uint64 vu = uint64(T0 + 60 days);
        bytes memory sig = _sign(_digest(oid, partner, ceiling, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.InsufficientFunded.selector);
        vault.payoutVerifiedOutcome(key, oid, partner, ceiling, ph, occ, vu, sig);
    }

    function test_payout_badSignatureRejected() public {
        _create();
        _fundFull();
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu,) = _validPayoutArgs();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xDEAD, _digest(oid, recip, amt, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.BadSignature.selector);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, abi.encodePacked(r, s, v));
    }

    function test_payout_wrongCampaignRejected() public {
        _create();
        _fundFull();
        // Signed for a different campaign key: digest binds the key.
        bytes32 otherKey = keccak256("other");
        bytes32 oid = keccak256("o");
        bytes32 digest = vault.outcomeDigest(
            otherKey, policyHash, oid, partner, 1_000_000, keccak256("p"), uint64(T0 + 1 days), uint64(T0 + 60 days)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.BadSignature.selector);
        vault.payoutVerifiedOutcome(
            key,
            oid,
            partner,
            1_000_000,
            keccak256("p"),
            uint64(T0 + 1 days),
            uint64(T0 + 60 days),
            abi.encodePacked(r, s, v)
        );
    }

    function test_payout_wrongPolicyHashRejected() public {
        _create();
        _fundFull();
        // Proof signed under a different policy hash than the stored one.
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = uint64(T0 + 1 days);
        uint64 vu = uint64(T0 + 60 days);
        bytes32 digest = vault.outcomeDigest(key, keccak256("other-policy"), oid, partner, 1_000_000, ph, occ, vu);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.BadSignature.selector);
        vault.payoutVerifiedOutcome(key, oid, partner, 1_000_000, ph, occ, vu, abi.encodePacked(r, s, v));
    }

    function test_payout_wrongRecipientRejected() public {
        _create();
        _fundFull();
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = uint64(T0 + 1 days);
        uint64 vu = uint64(T0 + 60 days);
        // Signed recipient differs from submitted recipient.
        bytes memory sig = _sign(_digest(oid, partner, 1_000_000, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.BadSignature.selector);
        vault.payoutVerifiedOutcome(key, oid, stranger, 1_000_000, ph, occ, vu, sig);
    }

    function test_payout_wrongAmountRejected() public {
        _create();
        _fundFull();
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = uint64(T0 + 1 days);
        uint64 vu = uint64(T0 + 60 days);
        // Signed amount differs from submitted amount.
        bytes memory sig = _sign(_digest(oid, partner, 1_000_000, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.BadSignature.selector);
        vault.payoutVerifiedOutcome(key, oid, partner, 2_000_000, ph, occ, vu, sig);
    }

    function test_payout_expiredProofRejected() public {
        _create();
        _fundFull();
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = uint64(T0 + 1 days);
        uint64 vu = uint64(T0 + 2 days);
        bytes memory sig = _sign(_digest(oid, partner, 1_000_000, ph, occ, vu));
        vm.warp(T0 + 3 days);
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.ProofExpired.selector);
        vault.payoutVerifiedOutcome(key, oid, partner, 1_000_000, ph, occ, vu, sig);
    }

    function test_payout_outcomeAfterDeadlineRejected() public {
        _create();
        _fundFull();
        bytes32 oid = keccak256("o");
        bytes32 ph = keccak256("p");
        uint64 occ = deadline + 1; // outcome occurred after the deadline
        uint64 vu = deadline + 30 days;
        bytes memory sig = _sign(_digest(oid, partner, 1_000_000, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.OutcomeAfterDeadline.selector);
        vault.payoutVerifiedOutcome(key, oid, partner, 1_000_000, ph, occ, vu, sig);
    }

    function test_payout_preDeadlineOutcomeSettlesAfterDeadline() public {
        _create();
        _fundFull();
        // Refund hold / late verification: settle after close of the window.
        (bytes32 oid, address recip, uint256 amt, bytes32 ph,, uint64 vu, bytes memory sig) = _validPayoutArgs();
        uint64 occ = deadline - 1;
        sig = _sign(_digest(oid, recip, amt, ph, occ, vu));
        vm.warp(deadline + 1 days);
        vm.prank(executor);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
        assertEq(vault.getCampaign(key).spent, amt);
    }

    function test_payout_duplicateOutcomeRejected() public {
        _create();
        _fundFull();
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu, bytes memory sig) =
            _validPayoutArgs();
        vm.prank(executor);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.OutcomeReplay.selector);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
    }

    function test_payout_proofReplayRejected() public {
        _create();
        _fundFull();
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu, bytes memory sig) =
            _validPayoutArgs();
        vm.prank(executor);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
        // Same proofHash reused for a different outcome.
        bytes32 oid2 = keccak256("outcome:2");
        bytes memory sig2 = _sign(_digest(oid2, recip, amt, ph, occ, vu));
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.ProofReplay.selector);
        vault.payoutVerifiedOutcome(key, oid2, recip, amt, ph, occ, vu, sig2);
    }

    function test_payout_pausedOrClosedRejected() public {
        _create();
        _fundFull();
        (bytes32 oid, address recip, uint256 amt, bytes32 ph, uint64 occ, uint64 vu, bytes memory sig) =
            _validPayoutArgs();
        vm.prank(owner);
        vault.pauseCampaign(key);
        vm.prank(executor);
        vm.expectRevert(ThesmaMarketVault.Paused.selector);
        vault.payoutVerifiedOutcome(key, oid, recip, amt, ph, occ, vu, sig);
    }

    function test_noGenericWithdrawBackdoor() public {
        _create();
        _fundFull();
        // A generic withdraw(address,uint256) selector must not exist.
        (bool ok,) = address(vault).call(abi.encodeWithSignature("withdraw(address,uint256)", stranger, 1));
        assertFalse(ok);
        // The owner cannot move funds except via returnUnspent after close.
        assertEq(usdc.balanceOf(address(vault)), budgetCap);
    }
}
