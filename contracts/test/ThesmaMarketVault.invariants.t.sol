// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ThesmaMarketVault} from "../src/ThesmaMarketVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Handler driving random vault operations for invariant testing.
contract VaultHandler is Test {
    ThesmaMarketVault vault;
    MockUSDC usdc;
    address owner;
    address executor;
    uint256 verifierKey;
    bytes32 key;
    uint256 budgetCap;

    constructor(
        ThesmaMarketVault _vault,
        MockUSDC _usdc,
        address _owner,
        address _executor,
        uint256 _verifierKey,
        bytes32 _key,
        uint256 _budgetCap
    ) {
        vault = _vault;
        usdc = _usdc;
        owner = _owner;
        executor = _executor;
        verifierKey = _verifierKey;
        key = _key;
        budgetCap = _budgetCap;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0, budgetCap);
        ThesmaMarketVault.Campaign memory c = vault.getCampaign(key);
        if (c.owner == address(0) || c.closed || c.paused) return;
        if (block.timestamp > c.deadline) return;
        if (amount == 0 || c.funded + amount > c.budgetCap) return;
        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        vault.fundCampaign(key, amount);
        vm.stopPrank();
    }

    function payout(uint256 amount, uint256 seed) external {
        amount = bound(amount, 1, 4_000_000);
        ThesmaMarketVault.Campaign memory c = vault.getCampaign(key);
        if (c.owner == address(0) || c.closed || c.paused) return;
        if (c.spent + amount > c.funded) return;
        bytes32 oid = keccak256(abi.encode("outcome", seed, c.spent));
        bytes32 ph = keccak256(abi.encode("proof", seed, c.spent));
        uint64 occ = uint64(block.timestamp > c.deadline ? c.deadline : block.timestamp);
        uint64 vu = uint64(block.timestamp + 30 days);
        bytes32 digest = vault.outcomeDigest(key, c.policyHash, oid, owner, amount, ph, occ, vu);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(verifierKey, digest);
        vm.prank(executor);
        vault.payoutVerifiedOutcome(key, oid, owner, amount, ph, occ, vu, abi.encodePacked(r, s, v));
    }

    function close() external {
        ThesmaMarketVault.Campaign memory c = vault.getCampaign(key);
        if (c.owner == address(0) || c.closed) return;
        vm.prank(owner);
        vault.closeCampaign(key);
    }
}

/// @notice Invariant: spent <= funded <= budgetCap across random operation mixes.
contract ThesmaMarketVaultInvariants is Test {
    ThesmaMarketVault vault;
    MockUSDC usdc;
    VaultHandler handler;

    address owner = address(0xA11CE);
    address executor = address(0xE1EC);
    uint256 verifierKey = 0x1234;
    bytes32 key = keccak256("thesma:invariant:campaign");
    uint256 budgetCap = 15_000_000;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUSDC();
        vault = new ThesmaMarketVault(address(usdc));
        usdc.mint(owner, 1_000_000_000_000);
        vm.prank(owner);
        vault.createCampaign(
            key,
            keccak256("policy"),
            budgetCap,
            4_000_000,
            uint64(block.timestamp + 30 days),
            executor,
            vm.addr(verifierKey)
        );
        handler = new VaultHandler(vault, usdc, owner, executor, verifierKey, key, budgetCap);
        targetContract(address(handler));
    }

    function invariant_moneyRelationshipsHold() public view {
        ThesmaMarketVault.Campaign memory c = vault.getCampaign(key);
        assertLe(c.spent, c.funded);
        assertLe(c.funded, c.budgetCap);
        assertLe(c.funded, c.budgetCap);
        assertEq(usdc.balanceOf(address(vault)), c.funded - c.spent);
    }
}
