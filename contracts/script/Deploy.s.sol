// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ThesmaMarketVault} from "../src/ThesmaMarketVault.sol";

/// @notice Explicit, opt-in deployment. Never runs during tests or builds.
/// @dev Usage (example, Arc testnet):
///      USDC_ADDRESS=0x... forge script script/Deploy.s.sol \
///        --rpc-url "$ARC_RPC_URL" --broadcast
///      A broadcast requires BOTH the env config AND the --broadcast flag.
///      Without --broadcast this is a dry run only.
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS required");
        vm.startBroadcast();
        ThesmaMarketVault vault = new ThesmaMarketVault(usdc);
        vm.stopBroadcast();
        console.log("ThesmaMarketVault deployed at:", address(vault));
        console.log("USDC:", usdc);
        console.log("Chain ID:", block.chainid);
    }
}
