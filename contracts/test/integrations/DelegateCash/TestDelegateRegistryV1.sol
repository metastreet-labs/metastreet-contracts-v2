// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.19;

import "../../../integrations/DelegateCash/IDelegateRegistryV1.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/**
 * @title Test DelegationRegistry
 *
 * @dev Subset of full contract
 */
contract TestDelegateRegistryV1 is IDelegateRegistryV1, ERC165 {
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice The global mapping and single source of truth for delegations
    /// @dev vault -> vaultVersion -> delegationHash
    mapping(address => mapping(uint256 => EnumerableSet.Bytes32Set)) internal delegations;

    /// @notice A mapping of wallets to versions (for cheap revocation)
    mapping(address => uint256) internal vaultVersion;

    /// @notice A mapping of wallets to delegates to versions (for cheap revocation)
    mapping(address => mapping(address => uint256)) internal delegateVersion;

    /// @notice A secondary mapping to return onchain enumerability of delegations that a given address can perform
    /// @dev delegate -> delegationHashes
    mapping(address => EnumerableSet.Bytes32Set) internal delegationHashes;

    /// @notice A secondary mapping used to return delegation information about a delegation
    /// @dev delegationHash -> DelegateInfo
    mapping(bytes32 => IDelegateRegistryV1.DelegationInfo) internal delegationInfo;

    /**
     * @inheritdoc ERC165
     */
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165) returns (bool) {
        return interfaceId == type(IDelegateRegistryV1).interfaceId || super.supportsInterface(interfaceId);
    }

    /**
     * -----------  WRITE -----------
     */

    /**
     * @inheritdoc IDelegateRegistryV1
     */
    function delegateForToken(address delegate, address contract_, uint256 tokenId, bool value) external override {
        bytes32 delegationHash = _computeTokenDelegationHash(msg.sender, delegate, contract_, tokenId);
        _setDelegationValues(
            delegate,
            delegationHash,
            value,
            IDelegateRegistryV1.DelegationType.TOKEN,
            msg.sender,
            contract_,
            tokenId
        );
        emit IDelegateRegistryV1.DelegateForToken(msg.sender, delegate, contract_, tokenId, value);
    }

    /**
     * @dev Helper function to set all delegation values and enumeration sets
     */
    function _setDelegationValues(
        address delegate,
        bytes32 delegateHash,
        bool value,
        IDelegateRegistryV1.DelegationType type_,
        address vault,
        address contract_,
        uint256 tokenId
    ) internal {
        if (value) {
            delegations[vault][vaultVersion[vault]].add(delegateHash);
            delegationHashes[delegate].add(delegateHash);
            delegationInfo[delegateHash] = DelegationInfo({
                vault: vault,
                delegate: delegate,
                type_: type_,
                contract_: contract_,
                tokenId: tokenId
            });
        } else {
            delegations[vault][vaultVersion[vault]].remove(delegateHash);
            delegationHashes[delegate].remove(delegateHash);
            delete delegationInfo[delegateHash];
        }
    }

    /**
     * @dev Helper function to compute delegation hash for wallet delegation
     */
    function _computeAllDelegationHash(address vault, address delegate) internal view returns (bytes32) {
        uint256 vaultVersion_ = vaultVersion[vault];
        uint256 delegateVersion_ = delegateVersion[vault][delegate];
        return keccak256(abi.encode(delegate, vault, vaultVersion_, delegateVersion_));
    }

    /**
     * @dev Helper function to compute delegation hash for contract delegation
     */
    function _computeContractDelegationHash(
        address vault,
        address delegate,
        address contract_
    ) internal view returns (bytes32) {
        uint256 vaultVersion_ = vaultVersion[vault];
        uint256 delegateVersion_ = delegateVersion[vault][delegate];
        return keccak256(abi.encode(delegate, vault, contract_, vaultVersion_, delegateVersion_));
    }

    /**
     * @dev Helper function to compute delegation hash for token delegation
     */
    function _computeTokenDelegationHash(
        address vault,
        address delegate,
        address contract_,
        uint256 tokenId
    ) internal view returns (bytes32) {
        uint256 vaultVersion_ = vaultVersion[vault];
        uint256 delegateVersion_ = delegateVersion[vault][delegate];
        return keccak256(abi.encode(delegate, vault, contract_, tokenId, vaultVersion_, delegateVersion_));
    }

    /**
     * -----------  READ -----------
     */

    /**
     * @inheritdoc IDelegateRegistryV1
     */
    function getDelegatesForToken(
        address vault,
        address contract_,
        uint256 tokenId
    ) external view override returns (address[] memory delegates) {
        return _getDelegatesForLevel(vault, IDelegateRegistryV1.DelegationType.TOKEN, contract_, tokenId);
    }

    function _getDelegatesForLevel(
        address vault,
        IDelegateRegistryV1.DelegationType delegationType,
        address contract_,
        uint256 tokenId
    ) internal view returns (address[] memory delegates) {
        EnumerableSet.Bytes32Set storage delegationHashes_ = delegations[vault][vaultVersion[vault]];
        uint256 potentialDelegatesLength = delegationHashes_.length();
        uint256 delegatesCount = 0;
        delegates = new address[](potentialDelegatesLength);
        for (uint256 i = 0; i < potentialDelegatesLength; ) {
            bytes32 delegationHash = delegationHashes_.at(i);
            DelegationInfo storage delegationInfo_ = delegationInfo[delegationHash];
            if (delegationInfo_.type_ == delegationType) {
                if (delegationType == IDelegateRegistryV1.DelegationType.ALL) {
                    // check delegate version by validating the hash
                    if (delegationHash == _computeAllDelegationHash(vault, delegationInfo_.delegate)) {
                        delegates[delegatesCount++] = delegationInfo_.delegate;
                    }
                } else if (delegationType == IDelegateRegistryV1.DelegationType.CONTRACT) {
                    if (delegationInfo_.contract_ == contract_) {
                        // check delegate version by validating the hash
                        if (
                            delegationHash == _computeContractDelegationHash(vault, delegationInfo_.delegate, contract_)
                        ) {
                            delegates[delegatesCount++] = delegationInfo_.delegate;
                        }
                    }
                } else if (delegationType == IDelegateRegistryV1.DelegationType.TOKEN) {
                    if (delegationInfo_.contract_ == contract_ && delegationInfo_.tokenId == tokenId) {
                        // check delegate version by validating the hash
                        if (
                            delegationHash ==
                            _computeTokenDelegationHash(vault, delegationInfo_.delegate, contract_, tokenId)
                        ) {
                            delegates[delegatesCount++] = delegationInfo_.delegate;
                        }
                    }
                }
            }
            unchecked {
                ++i;
            }
        }
        if (potentialDelegatesLength > delegatesCount) {
            assembly {
                let decrease := sub(potentialDelegatesLength, delegatesCount)
                mstore(delegates, sub(mload(delegates), decrease))
            }
        }
    }

    /**
     * @inheritdoc IDelegateRegistryV1
     */
    function checkDelegateForAll(address delegate, address vault) public view override returns (bool) {
        bytes32 delegateHash = keccak256(
            abi.encode(delegate, vault, vaultVersion[vault], delegateVersion[vault][delegate])
        );
        return delegations[vault][vaultVersion[vault]].contains(delegateHash);
    }

    /**
     * @inheritdoc IDelegateRegistryV1
     */
    function checkDelegateForContract(
        address delegate,
        address vault,
        address contract_
    ) public view override returns (bool) {
        bytes32 delegateHash = keccak256(
            abi.encode(delegate, vault, contract_, vaultVersion[vault], delegateVersion[vault][delegate])
        );
        return
            delegations[vault][vaultVersion[vault]].contains(delegateHash)
                ? true
                : checkDelegateForAll(delegate, vault);
    }

    /**
     * @inheritdoc IDelegateRegistryV1
     */
    function checkDelegateForToken(
        address delegate,
        address vault,
        address contract_,
        uint256 tokenId
    ) public view override returns (bool) {
        bytes32 delegateHash = keccak256(
            abi.encode(delegate, vault, contract_, tokenId, vaultVersion[vault], delegateVersion[vault][delegate])
        );
        return
            delegations[vault][vaultVersion[vault]].contains(delegateHash)
                ? true
                : checkDelegateForContract(delegate, vault, contract_);
    }
}
