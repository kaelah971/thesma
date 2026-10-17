// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ThesmaMarketVault} from "../src/ThesmaMarketVault.sol";

/// @notice Explicit, opt-in deployment. Never runs during tests or builds.
/// @dev SAFETY: this script refuses to broadcast unless BOTH gates pass:
///      1. EXPECTED_CHAIN_ID equals the RPC's chain id (no wrong-network deploys).
///      2. EXPECTED_DEPLOYER equals the broadcasting sender (no surprise signer).
///      Usage (Arc mainnet, after owner approval):
///        USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
///        EXPECTED_CHAIN_ID=5042 \
///        EXPECTED_DEPLOYER=0xYourDeployer \
///        forge script script/Deploy.s.sol \
///          --rpc-url "$ARC_RPC_URL" --account <name> --broadcast
///      Without --broadcast this is a read-only dry run (simulation only).
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS required");
        uint256 expectedChain = vm.envUint("EXPECTED_CHAIN_ID");
        require(block.chainid == expectedChain, "CHAIN MISMATCH: aborting");
        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        require(msg.sender == expectedDeployer, "DEPLOYER MISMATCH: aborting");

        console.log("=== ThesmaMarketVault deployment plan ===");
        console.log("Chain ID (verified):", block.chainid);
        console.log("Deployer (verified):", msg.sender);
        console.log("USDC:", usdc);

        vm.startBroadcast();
        ThesmaMarketVault vault = new ThesmaMarketVault(usdc);
        vm.stopBroadcast();

        console.log("ThesmaMarketVault deployed at:", address(vault));
    }
}
