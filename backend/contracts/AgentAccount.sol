// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {GameEscrow} from "./GameEscrow.sol";

/// @notice Minimal dedicated agent account; the hosted key cannot execute arbitrary calls.
/// @dev Owner can be an EOA or a passkey smart account. No platform admin or upgrade mechanism.
contract AgentAccount is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable owner;
    GameEscrow public immutable escrow;
    IERC20 public immutable usdc;
    struct Policy { address key; uint256 maxStake; uint256 dailyBudget; uint32 gamesPerDay; uint64 expiresAt; uint8 gameMask; }
    struct Usage { uint256 stake; uint32 games; }
    Policy public policy;
    mapping(uint256 => Usage) public dailyUsage;
    bytes32 public activeMatch;
    error OwnerOnly();
    error PermissionDenied();
    error BudgetExceeded();
    error MatchInProgress();
    event PolicyUpdated(address indexed key, uint256 maxStake, uint256 dailyBudget, uint32 gamesPerDay, uint64 expiresAt, uint8 gameMask);
    event PermissionRevoked();
    event Withdrawn(uint256 amount);
    constructor(address accountOwner, address gameEscrow) {
        if (accountOwner == address(0) || gameEscrow == address(0)) revert PermissionDenied();
        owner = accountOwner; escrow = GameEscrow(gameEscrow); usdc = escrow.usdc();
    }
    modifier onlyOwner() { if (msg.sender != owner) revert OwnerOnly(); _; }
    function setPolicy(Policy calldata next) external onlyOwner {
        if (next.key == address(0) || next.maxStake < escrow.MIN_STAKE() || next.maxStake > escrow.MAX_STAKE() || next.dailyBudget == 0 || next.gamesPerDay == 0 || next.gamesPerDay > 100 || next.gameMask == 0 || next.gameMask > 3 || next.expiresAt <= block.timestamp || next.expiresAt > block.timestamp + 30 days) revert PermissionDenied();
        policy = next;
        // Usage belongs to the account, not the key. Rotation never resets today's budget.
        emit PolicyUpdated(next.key, next.maxStake, next.dailyBudget, next.gamesPerDay, next.expiresAt, next.gameMask);
    }
    function revoke() external onlyOwner { delete policy; emit PermissionRevoked(); }
    function _spend(uint8 game, uint256 stake) private {
        Policy memory p = policy;
        if (msg.sender != p.key || block.timestamp >= p.expiresAt || game > 1 || (p.gameMask & uint8(1 << game)) == 0) revert PermissionDenied();
        if (activeMatch != bytes32(0)) {
            (,,GameEscrow.Status status,,,,) = escrow.getMatch(activeMatch);
            if (status == GameEscrow.Status.Open || status == GameEscrow.Status.Active) revert MatchInProgress();
        }
        Usage storage u = dailyUsage[block.timestamp / 1 days];
        if (stake > p.maxStake || u.stake + stake > p.dailyBudget || u.games >= p.gamesPerDay) revert BudgetExceeded();
        u.stake += stake; u.games++;
        usdc.forceApprove(address(escrow), stake);
    }
    function createMatch(bytes32 id, uint8 game, uint256 stake, uint64 fillDeadline, uint32 playSeconds, bytes32 rulesHash) external nonReentrant {
        _spend(game, stake);
        escrow.createMatch(id, game, stake, fillDeadline, playSeconds, rulesHash);
        usdc.forceApprove(address(escrow), 0);
        activeMatch = id;
    }
    function joinMatch(bytes32 id, uint256 expectedStake) external nonReentrant {
        (uint8 game, uint256 stake,,,,,) = escrow.getMatch(id);
        if (stake != expectedStake) revert PermissionDenied();
        _spend(game, stake);
        escrow.joinMatch(id, expectedStake);
        usdc.forceApprove(address(escrow), 0);
        activeMatch = id;
    }
    function createMatchWithEquipment(bytes32 id, uint8 game, uint256 stake, uint64 fillDeadline, uint32 playSeconds, bytes32 rulesHash, bytes32 equipmentCommitment) external nonReentrant {
        _spend(game, stake);
        escrow.createMatchWithEquipment(id, game, stake, fillDeadline, playSeconds, rulesHash, equipmentCommitment);
        usdc.forceApprove(address(escrow), 0);
        activeMatch = id;
    }
    function joinMatchWithEquipment(bytes32 id, uint256 expectedStake, bytes32 equipmentCommitment) external nonReentrant {
        (uint8 game, uint256 stake,,,,,) = escrow.getMatch(id);
        if (stake != expectedStake) revert PermissionDenied();
        _spend(game, stake);
        escrow.joinMatchWithEquipment(id, expectedStake, equipmentCommitment);
        usdc.forceApprove(address(escrow), 0);
        activeMatch = id;
    }
    // Claim is permissionless because the escrow always returns credit to this account.
    function claim() external nonReentrant { escrow.claim(); }
    function cancelExpired(bytes32 id) external nonReentrant { escrow.cancelExpired(id); }
    function cancelUnfilled(bytes32 id) external onlyOwner nonReentrant { escrow.cancelUnfilled(id); }
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        usdc.safeTransfer(owner, amount);
        emit Withdrawn(amount);
    }
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(owner, hash, signature) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    // Native funding is USDC on Arc. Generic native withdrawals and arbitrary execute are absent.
    receive() external payable {}
}
