// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.20;

import {IDelegateRegistryV2 as IDelegateRegistry} from "../../../integrations/DelegateCash/IDelegateRegistryV2.sol";
import {RegistryHashes as Hashes} from "./libraries/RegistryHashes.sol";
import {RegistryStorage as Storage} from "./libraries/RegistryStorage.sol";
import {RegistryOps as Ops} from "./libraries/RegistryOps.sol";

/**
 * @title Test DelegateRegistry
 *
 * @dev Subset of full contract
 */
contract TestDelegateRegistryV2 is IDelegateRegistry {
    /// @dev Only this mapping should be used to verify delegations; the other mapping arrays are for enumerations
    mapping(bytes32 delegationHash => bytes32[5] delegationStorage) internal delegations;

    /// @dev Vault delegation enumeration outbox, for pushing new hashes only
    mapping(address from => bytes32[] delegationHashes) internal outgoingDelegationHashes;

    /// @dev Delegate enumeration inbox, for pushing new hashes only
    mapping(address to => bytes32[] delegationHashes) internal incomingDelegationHashes;

    /**
     * ----------- WRITE -----------
     */

    /// @inheritdoc IDelegateRegistry
    function delegateERC721(
        address to,
        address contract_,
        uint256 tokenId,
        bytes32 rights,
        bool enable
    ) external payable override returns (bytes32 hash) {
        hash = Hashes.erc721Hash(msg.sender, rights, to, tokenId, contract_);
        bytes32 location = Hashes.location(hash);
        address loadedFrom = _loadFrom(location);
        if (enable) {
            if (loadedFrom == Storage.DELEGATION_EMPTY) {
                _pushDelegationHashes(msg.sender, to, hash);
                _writeDelegationAddresses(location, msg.sender, to, contract_);
                _writeDelegation(location, Storage.POSITIONS_TOKEN_ID, tokenId);
                if (rights != "") _writeDelegation(location, Storage.POSITIONS_RIGHTS, rights);
            } else if (loadedFrom == Storage.DELEGATION_REVOKED) {
                _updateFrom(location, msg.sender);
            }
        } else if (loadedFrom == msg.sender) {
            _updateFrom(location, Storage.DELEGATION_REVOKED);
        }
        emit DelegateERC721(msg.sender, to, contract_, tokenId, rights, enable);
    }

    /**
     * ----------- CHECKS -----------
     */

    /// @inheritdoc IDelegateRegistry
    function checkDelegateForERC721(
        address to,
        address from,
        address contract_,
        uint256 tokenId,
        bytes32 rights
    ) external view override returns (bool valid) {
        if (!_invalidFrom(from)) {
            valid =
                _validateFrom(Hashes.allLocation(from, "", to), from) ||
                _validateFrom(Hashes.contractLocation(from, "", to, contract_), from) ||
                _validateFrom(Hashes.erc721Location(from, "", to, tokenId, contract_), from);
            if (!Ops.or(rights == "", valid)) {
                valid =
                    _validateFrom(Hashes.allLocation(from, rights, to), from) ||
                    _validateFrom(Hashes.contractLocation(from, rights, to, contract_), from) ||
                    _validateFrom(Hashes.erc721Location(from, rights, to, tokenId, contract_), from);
            }
        }
        assembly ("memory-safe") {
            // Only first 32 bytes of scratch space is accessed
            mstore(0, iszero(iszero(valid))) // Compiler cleans dirty booleans on the stack to 1, so do the same here
            return(0, 32) // Direct return, skips Solidity's redundant copying to save gas
        }
    }

    /**
     * ----------- ENUMERATIONS -----------
     */

    /// @inheritdoc IDelegateRegistry
    function getOutgoingDelegations(address from) external view returns (Delegation[] memory delegations_) {
        delegations_ = _getValidDelegationsFromHashes(outgoingDelegationHashes[from]);
    }

    /**
     * ----------- ERC165 -----------
     */

    /// @notice Query if a contract implements an ERC-165 interface
    /// @param interfaceId The interface identifier
    /// @return valid Whether the queried interface is supported
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return Ops.or(interfaceId == type(IDelegateRegistry).interfaceId, interfaceId == 0x01ffc9a7);
    }

    /**
     * ----------- INTERNAL -----------
     */

    /// @dev Helper function to push new delegation hashes to the incoming and outgoing hashes mappings
    function _pushDelegationHashes(address from, address to, bytes32 delegationHash) internal {
        outgoingDelegationHashes[from].push(delegationHash);
        incomingDelegationHashes[to].push(delegationHash);
    }

    /// @dev Helper function that writes bytes32 data to delegation data location at array position
    function _writeDelegation(bytes32 location, uint256 position, bytes32 data) internal {
        assembly {
            sstore(add(location, position), data)
        }
    }

    /// @dev Helper function that writes uint256 data to delegation data location at array position
    function _writeDelegation(bytes32 location, uint256 position, uint256 data) internal {
        assembly {
            sstore(add(location, position), data)
        }
    }

    /// @dev Helper function that writes addresses according to the packing rule for delegation storage
    function _writeDelegationAddresses(bytes32 location, address from, address to, address contract_) internal {
        (bytes32 firstSlot, bytes32 secondSlot) = Storage.packAddresses(from, to, contract_);
        uint256 firstPacked = Storage.POSITIONS_FIRST_PACKED;
        uint256 secondPacked = Storage.POSITIONS_SECOND_PACKED;
        assembly {
            sstore(add(location, firstPacked), firstSlot)
            sstore(add(location, secondPacked), secondSlot)
        }
    }

    /// @dev Helper function that writes `from` while preserving the rest of the storage slot
    function _updateFrom(bytes32 location, address from) internal {
        uint256 firstPacked = Storage.POSITIONS_FIRST_PACKED;
        uint256 cleanAddress = Storage.CLEAN_ADDRESS;
        uint256 cleanUpper12Bytes = type(uint256).max << 160;
        assembly {
            let slot := and(sload(add(location, firstPacked)), cleanUpper12Bytes)
            sstore(add(location, firstPacked), or(slot, and(from, cleanAddress)))
        }
    }

    /// @dev Helper function that takes an array of delegation hashes and returns an array of Delegation structs with their onchain information
    function _getValidDelegationsFromHashes(
        bytes32[] storage hashes
    ) internal view returns (Delegation[] memory delegations_) {
        uint256 count = 0;
        uint256 hashesLength = hashes.length;
        bytes32 hash;
        bytes32[] memory filteredHashes = new bytes32[](hashesLength);
        unchecked {
            for (uint256 i = 0; i < hashesLength; ++i) {
                hash = hashes[i];
                if (_invalidFrom(_loadFrom(Hashes.location(hash)))) continue;
                filteredHashes[count++] = hash;
            }
            delegations_ = new Delegation[](count);
            bytes32 location;
            for (uint256 i = 0; i < count; ++i) {
                hash = filteredHashes[i];
                location = Hashes.location(hash);
                (address from, address to, address contract_) = _loadDelegationAddresses(location);
                delegations_[i] = Delegation({
                    type_: Hashes.decodeType(hash),
                    to: to,
                    from: from,
                    rights: _loadDelegationBytes32(location, Storage.POSITIONS_RIGHTS),
                    amount: _loadDelegationUint(location, Storage.POSITIONS_AMOUNT),
                    contract_: contract_,
                    tokenId: _loadDelegationUint(location, Storage.POSITIONS_TOKEN_ID)
                });
            }
        }
    }

    /// @dev Helper function that takes an array of delegation hashes and returns an array of valid delegation hashes
    function _getValidDelegationHashesFromHashes(
        bytes32[] storage hashes
    ) internal view returns (bytes32[] memory validHashes) {
        uint256 count = 0;
        uint256 hashesLength = hashes.length;
        bytes32 hash;
        bytes32[] memory filteredHashes = new bytes32[](hashesLength);
        unchecked {
            for (uint256 i = 0; i < hashesLength; ++i) {
                hash = hashes[i];
                if (_invalidFrom(_loadFrom(Hashes.location(hash)))) continue;
                filteredHashes[count++] = hash;
            }
            validHashes = new bytes32[](count);
            for (uint256 i = 0; i < count; ++i) {
                validHashes[i] = filteredHashes[i];
            }
        }
    }

    /// @dev Helper function that loads delegation data from a particular array position and returns as bytes32
    function _loadDelegationBytes32(bytes32 location, uint256 position) internal view returns (bytes32 data) {
        assembly {
            data := sload(add(location, position))
        }
    }

    /// @dev Helper function that loads delegation data from a particular array position and returns as uint256
    function _loadDelegationUint(bytes32 location, uint256 position) internal view returns (uint256 data) {
        assembly {
            data := sload(add(location, position))
        }
    }

    // @dev Helper function that loads the from address from storage according to the packing rule for delegation storage
    function _loadFrom(bytes32 location) internal view returns (address) {
        bytes32 data;
        uint256 firstPacked = Storage.POSITIONS_FIRST_PACKED;
        assembly {
            data := sload(add(location, firstPacked))
        }
        return Storage.unpackAddress(data);
    }

    /// @dev Helper function to establish whether a delegation is enabled
    function _validateFrom(bytes32 location, address from) internal view returns (bool) {
        return (from == _loadFrom(location));
    }

    /// @dev Helper function that loads the address for the delegation according to the packing rule for delegation storage
    function _loadDelegationAddresses(
        bytes32 location
    ) internal view returns (address from, address to, address contract_) {
        bytes32 firstSlot;
        bytes32 secondSlot;
        uint256 firstPacked = Storage.POSITIONS_FIRST_PACKED;
        uint256 secondPacked = Storage.POSITIONS_SECOND_PACKED;
        assembly {
            firstSlot := sload(add(location, firstPacked))
            secondSlot := sload(add(location, secondPacked))
        }
        (from, to, contract_) = Storage.unpackAddresses(firstSlot, secondSlot);
    }

    function _invalidFrom(address from) internal pure returns (bool) {
        return Ops.or(from == Storage.DELEGATION_EMPTY, from == Storage.DELEGATION_REVOKED);
    }
}
