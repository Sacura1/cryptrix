// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Equal-stake match escrow. Immutable resolver attests results, never arbitrary recipients.
/// @dev No treasury, upgrade authority or admin withdrawals. This is NOT trustless result verification.
contract GameEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable usdc;
    address public immutable resolver;
    /// @notice Account authorized to update feeRecipient.
    address public immutable owner;
    /// @notice Recipient of the platform fee charged on settled matches.
    address public feeRecipient;
    uint256 public constant VERSION = 4;
    uint256 public constant MIN_STAKE = 500_000;
    uint256 public constant MAX_STAKE = 5_000_000;
    uint256 public constant FEE_BPS = 100;
    bytes32[5] public openRooms;
    mapping(address => bytes32) public currentMatch;
    enum Status { None, Open, Active, Settled, Cancelled }
    struct Match {
        uint8 game;
        uint256 stake;
        Status status;
        uint64 fillDeadline;
        uint64 resolveDeadline;
        uint32 playSeconds;
        bytes32 rulesHash;
        address[] participants;
    }
    mapping(bytes32 => Match) private matches;
    mapping(address => uint256) public credits;
    /// @notice Accumulated platform fees claimable by feeRecipient (pull pattern — never pushed during settlement).
    mapping(address => uint256) public feeCredits;
    mapping(bytes32 => bytes32) public resultHashes;
    mapping(bytes32 => uint8[]) private settledRanks;
    mapping(bytes32 => mapping(address => bytes32)) public equipmentCommitments;
    bytes32 public constant DEFAULT_EQUIPMENT = sha256('{"armor":1,"attack":1,"sensor":2}');

    error InvalidTerms();
    error WrongState();
    error DuplicateEntrant();
    error NotResolver();
    error InvalidRanks();
    error NoCredit();
    error RoomAlreadyOpen(bytes32 id);
    error OpenRoomLimit();
    error WalletBusy(bytes32 id);
    error NotOwner();
    event MatchCreated(bytes32 indexed id, address indexed creator, uint8 game, uint256 stake, bytes32 rulesHash);
    event MatchJoined(bytes32 indexed id, address indexed entrant, uint8 slot);
    event EquipmentCommitted(bytes32 indexed id, address indexed entrant, bytes32 commitment);
    event MatchStarted(bytes32 indexed id, uint64 resolveDeadline);
    event MatchSettled(bytes32 indexed id, bytes32 resultHash, uint8[] rankGroups);
    event MatchCancelled(bytes32 indexed id);
    event CreditClaimed(address indexed account, uint256 amount);
    event FeeClaimed(address indexed recipient, uint256 amount);
    /// @notice Emitted when the owner updates the platform fee recipient.
    event FeeRecipientUpdated(address indexed previous, address indexed next);

    constructor(address token, address resultResolver, address feeOwner) {
        if (token == address(0) || resultResolver == address(0) || IERC20Metadata(token).decimals() != 6 || feeOwner == address(0)) revert InvalidTerms();
        usdc = IERC20(token);
        resolver = resultResolver;
        owner = feeOwner;
        feeRecipient = feeOwner;
    }
    /// @notice Updates the platform fee recipient.
    function setFeeRecipient(address newRecipient) external {
        if (msg.sender != owner) revert NotOwner();
        if (newRecipient == address(0)) revert InvalidTerms();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }
    function capacity(uint8 game) public pure returns (uint8) {
        if (game > 1) revert InvalidTerms();
        return game == 0 ? 2 : 8;
    }
    function createMatch(bytes32 id, uint8 game, uint256 stake, uint64 fillDeadline, uint32 playSeconds, bytes32 rulesHash) external nonReentrant {
        _createMatch(id, game, stake, fillDeadline, playSeconds, rulesHash, DEFAULT_EQUIPMENT);
    }
    function createMatchWithEquipment(bytes32 id, uint8 game, uint256 stake, uint64 fillDeadline, uint32 playSeconds, bytes32 rulesHash, bytes32 equipmentCommitment, uint64 fundingDeadline) external nonReentrant {
        if (block.timestamp >= fundingDeadline) revert WrongState();
        _createMatch(id, game, stake, fillDeadline, playSeconds, rulesHash, equipmentCommitment);
    }
    function _createMatch(bytes32 id, uint8 game, uint256 stake, uint64 fillDeadline, uint32 playSeconds, bytes32 rulesHash, bytes32 equipmentCommitment) private {
        if (equipmentCommitment == bytes32(0)) revert InvalidTerms();
        if (id == bytes32(0) || rulesHash == bytes32(0) || matches[id].status != Status.None || game > 1 || stake < MIN_STAKE || stake > MAX_STAKE || (stake != MIN_STAKE && stake % 1_000_000 != 0)) revert InvalidTerms();
        if (fillDeadline <= block.timestamp || fillDeadline > block.timestamp + 15 minutes || playSeconds < 60 || playSeconds > 1 hours) revert InvalidTerms();
        uint256 slot = 5;
        for (uint256 i; i < 5; ++i) {
            bytes32 existing = openRooms[i];
            if (existing != bytes32(0) && matches[existing].fillDeadline <= block.timestamp) _refund(existing, matches[existing]);
            if (openRooms[i] == bytes32(0)) { slot = i; continue; }
            if (matches[existing].game == game && matches[existing].stake == stake) revert RoomAlreadyOpen(existing);
        }
        if (slot == 5) revert OpenRoomLimit();
        _available(msg.sender);
        openRooms[slot] = id;
        currentMatch[msg.sender] = id;
        Match storage m = matches[id];
        m.game = game; m.stake = stake; m.status = Status.Open;
        m.fillDeadline = fillDeadline; m.playSeconds = playSeconds; m.rulesHash = rulesHash;
        m.participants.push(msg.sender);
        equipmentCommitments[id][msg.sender] = equipmentCommitment;
        usdc.safeTransferFrom(msg.sender, address(this), stake);
        emit MatchCreated(id, msg.sender, game, stake, rulesHash);
        emit MatchJoined(id, msg.sender, 0);
        emit EquipmentCommitted(id, msg.sender, equipmentCommitment);
    }
    function joinMatch(bytes32 id, uint256 expectedStake) external nonReentrant {
        _joinMatch(id, expectedStake, DEFAULT_EQUIPMENT);
    }
    function joinMatchWithEquipment(bytes32 id, uint256 expectedStake, bytes32 equipmentCommitment) external nonReentrant {
        _joinMatch(id, expectedStake, equipmentCommitment);
    }
    function _joinMatch(bytes32 id, uint256 expectedStake, bytes32 equipmentCommitment) private {
        if (equipmentCommitment == bytes32(0)) revert InvalidTerms();
        Match storage m = matches[id];
        if (m.status != Status.Open || block.timestamp >= m.fillDeadline || expectedStake != m.stake) revert WrongState();
        for (uint256 i; i < m.participants.length; ++i) if (m.participants[i] == msg.sender) revert DuplicateEntrant();
        _available(msg.sender);
        currentMatch[msg.sender] = id;
        uint8 slot = uint8(m.participants.length);
        m.participants.push(msg.sender);
        equipmentCommitments[id][msg.sender] = equipmentCommitment;
        usdc.safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(id, msg.sender, slot);
        emit EquipmentCommitted(id, msg.sender, equipmentCommitment);
        if (m.participants.length == capacity(m.game)) {
            _releaseRoom(id);
            m.status = Status.Active;
            m.resolveDeadline = uint64(block.timestamp + m.playSeconds);
            emit MatchStarted(id, m.resolveDeadline);
        }
    }
    function getMatch(bytes32 id) external view returns (uint8 game, uint256 stake, Status status, uint8 filled, uint64 fillDeadline, uint64 resolveDeadline, bytes32 rulesHash) {
        Match storage m = matches[id];
        return (m.game, m.stake, m.status, uint8(m.participants.length), m.fillDeadline, m.resolveDeadline, m.rulesHash);
    }
    function participants(bytes32 id) external view returns (address[] memory) { return matches[id].participants; }
    function getResult(bytes32 id) external view returns (bytes32 resultHash, uint8[] memory rankGroups) { return (resultHashes[id], settledRanks[id]); }
    /// @notice Dense ranking groups in original entry order. Ties share prizes for occupied positions.
    function settleMatch(bytes32 id, uint8[] calldata rankGroups, bytes32 resultHash) external nonReentrant {
        if (msg.sender != resolver) revert NotResolver();
        Match storage m = matches[id];
        if (m.status != Status.Active || block.timestamp >= m.resolveDeadline) revert WrongState();
        uint256 n = m.participants.length;
        if (rankGroups.length != n || resultHash == bytes32(0)) revert InvalidRanks();
        uint256[] memory counts = new uint256[](n);
        uint256 maxGroup;
        for (uint256 i; i < n; ++i) {
            if (rankGroups[i] >= n) revert InvalidRanks();
            counts[rankGroups[i]]++;
            if (rankGroups[i] > maxGroup) maxGroup = rankGroups[i];
        }
        for (uint256 g; g <= maxGroup; ++g) if (counts[g] == 0) revert InvalidRanks();
        m.status = Status.Settled;
        for (uint256 i; i < n; ++i) delete currentMatch[m.participants[i]];
        resultHashes[id] = resultHash;
        settledRanks[id] = rankGroups;
        uint256 pot = m.stake * n;
        uint256 fee = pot * FEE_BPS / 10_000;
        uint256 prizePot = pot - fee;
        // Pull pattern: credit fee to current feeRecipient — never push during settlement.
        // This ensures a blocklisted or non-receiving feeRecipient can never freeze settlement.
        if (fee != 0) feeCredits[feeRecipient] += fee;
        uint256 position;
        for (uint256 g; g <= maxGroup; ++g) {
            uint256 prize;
            for (uint256 j; j < counts[g]; ++j) prize += _positionPrize(m.game, prizePot, position + j);
            uint256 share = prize / counts[g];
            uint256 remainder = prize % counts[g];
            for (uint256 i; i < n; ++i) if (rankGroups[i] == g) {
                credits[m.participants[i]] += share + (remainder > 0 ? 1 : 0);
                if (remainder > 0) remainder--;
            }
            position += counts[g];
        }
        emit MatchSettled(id, resultHash, rankGroups);
    }
    function _positionPrize(uint8 game, uint256 pot, uint256 position) private pure returns (uint256) {
        if (game == 0) return position == 0 ? pot : 0;
        if (position == 0) return pot * 60 / 100;
        if (position == 1) return pot * 25 / 100;
        if (position == 2) return pot - pot * 60 / 100 - pot * 25 / 100;
        return 0;
    }
    /// @notice Anyone can release an unfilled or unresolved pot after its fixed deadline.
    function cancelExpired(bytes32 id) external nonReentrant {
        Match storage m = matches[id];
        if (!((m.status == Status.Open && block.timestamp >= m.fillDeadline) || (m.status == Status.Active && block.timestamp >= m.resolveDeadline))) revert WrongState();
        _refund(id, m);
    }
    /// @notice Creator can cancel only while nobody else has committed funds.
    function cancelUnfilled(bytes32 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Open || m.participants.length != 1 || m.participants[0] != msg.sender) revert WrongState();
        _refund(id, m);
    }
    function _refund(bytes32 id, Match storage m) private {
        _releaseRoom(id);
        m.status = Status.Cancelled;
        for (uint256 i; i < m.participants.length; ++i) {
            credits[m.participants[i]] += m.stake;
            delete currentMatch[m.participants[i]];
        }
        emit MatchCancelled(id);
    }
    function _releaseRoom(bytes32 id) private {
        for (uint256 i; i < 5; ++i) if (openRooms[i] == id) delete openRooms[i];
    }
    function _available(address entrant) private {
        bytes32 previous = currentMatch[entrant];
        if (previous == bytes32(0)) return;
        Match storage m = matches[previous];
        if ((m.status == Status.Open && block.timestamp >= m.fillDeadline) || (m.status == Status.Active && block.timestamp >= m.resolveDeadline)) _refund(previous, m);
        else revert WalletBusy(previous);
    }
    /// @notice Recipient is fixed to the credited entrant. One failed transfer cannot freeze others.
    function claim() external nonReentrant {
        _claim(msg.sender);
    }
    /// @notice Anyone may pay gas, but nobody can change the beneficiary.
    function claimFor(address entrant) external nonReentrant {
        if (credits[entrant] != 0) _claim(entrant);
    }
    /// @notice Withdraw accumulated platform fees. Anyone may pay gas; funds go to the credited recipient only.
    function claimFee(address recipient) external nonReentrant {
        uint256 amount = feeCredits[recipient];
        if (amount == 0) revert NoCredit();
        feeCredits[recipient] = 0;
        usdc.safeTransfer(recipient, amount);
        emit FeeClaimed(recipient, amount);
    }
    function _claim(address entrant) private {
        uint256 amount = credits[entrant];
        if (amount == 0) revert NoCredit();
        credits[entrant] = 0;
        usdc.safeTransfer(entrant, amount);
        emit CreditClaimed(entrant, amount);
    }
}
