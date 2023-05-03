// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

library FixedSizeArray {
    struct Uint64Array {
        uint8 len;
        uint64[3] elements;
    }

    error OutOfBounds();

    function push(Uint64Array storage arr, uint64 element) internal {
        if (arr.len == arr.elements.length) revert OutOfBounds();

        arr.elements[arr.len] = element;
        arr.len += 1;
    }

    function length(Uint64Array storage arr) internal view returns (uint256) {
        return arr.len;
    }

    function capacity(Uint64Array storage arr) internal view returns (uint256) {
        return arr.elements.length;
    }

    function get(Uint64Array storage arr, uint256 position) internal view returns (uint64) {
        return arr.elements[position];
    }

    function toDynamic(Uint64Array storage arr) internal view returns (uint64[] memory) {
        uint64[] memory dynArr = new uint64[](arr.len);
        for (uint256 i; i < arr.len; i++) {
            dynArr[i] = arr.elements[i];
        }
        return dynArr;
    }
}
