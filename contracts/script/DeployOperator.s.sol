// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ThesmaOperatorVault} from "../src/ThesmaOperatorVault.sol";

/// @notice Testnet-only deployment for the hardened operator vault (RFB 04).
/// @dev NEVER points at Arc mainnet: the script refuses any chain other than
///      Canteen testnet (5042002) and refuses unknown deployers. The v1
///      ThesmaMarketVault on mainnet is never touched or replaced.
///      Usage (after owner approval, credentials in env — never committed):
///        USDC_ADDRESS=0x<testnet-usdc> \
///        EXPECTED_DEPLOYER=0xYourDeployer \
///        forge script script/DeployOperator.s.sol \
///          --rpc-url "$ARC_TESTNET_RPC_URL" --account <name> --broadcast
///      Without --broadcast this is a read-only dry run (simulation only).
contract DeployOperator is Script {
    uint256 private constant CANTEEN_TESTNET_CHAIN_ID = 5042002;

    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS required");
        require(block.chainid == CANTEEN_TESTNET_CHAIN_ID, "CHAIN MISMATCH: Canteen testnet (5042002) only");
        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        require(msg.sender == expectedDeployer, "DEPLOYER MISMATCH: aborting");

        console.log("=== ThesmaOperatorVault deployment plan (TESTNET ONLY) ===");
        console.log("Chain ID (verified):", block.chainid);
        console.log("Deployer (verified):", msg.sender);
        console.log("USDC:", usdc);

        vm.startBroadcast();
        ThesmaOperatorVault vault = new ThesmaOperatorVault(usdc);
        vm.stopBroadcast();

        console.log("ThesmaOperatorVault deployed at:", address(vault));
    }
}
