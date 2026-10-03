// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AgentAccount} from "./AgentAccount.sol";
/// @notice Registers accounts created with the fixed, non-upgradeable implementation.
contract AgentAccountFactory {
    address public immutable escrow;
    mapping(address => bool) public isAccount;
    event AccountCreated(address indexed account, address indexed owner);
    constructor(address gameEscrow) { require(gameEscrow != address(0)); escrow = gameEscrow; }
    function predict(address owner, bytes32 salt) external view returns (address) {
        bytes32 scopedSalt = keccak256(abi.encode(owner, salt));
        bytes32 codeHash = keccak256(abi.encodePacked(type(AgentAccount).creationCode, abi.encode(owner, escrow)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), scopedSalt, codeHash)))));
    }
    function create(address owner, bytes32 salt) external returns (address account) {
        bytes32 scopedSalt = keccak256(abi.encode(owner, salt));
        account = address(new AgentAccount{salt: scopedSalt}(owner, escrow));
        isAccount[account] = true;
        emit AccountCreated(account, owner);
    }
}
