// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

library PackedArray {
    struct Uint64Array {
        /* 0 is length, 1-N are elements */
        uint64[4] data;
    }

    error OutOfBounds();

    function push(Uint64Array storage arr, uint64 element) internal {
        if (arr.data[0] == arr.data.length - 1) revert OutOfBounds();

        arr.data[arr.data[0] + 1] = element;
        arr.data[0] += 1;
    }

    function length(Uint64Array storage arr) internal view returns (uint256) {
        return arr.data[0];
    }

    function capacity(Uint64Array storage arr) internal view returns (uint256) {
        return arr.data.length - 1;
    }

    function get(Uint64Array storage arr, uint256 position) internal view returns (uint64) {
        return arr.data[position + 1];
    }

    function toDynamic(Uint64Array storage arr) internal view returns (uint64[] memory) {
        uint64[] memory dynArr = new uint64[](arr.data[0]);
        for (uint256 i; i < dynArr.length; i++) {
            dynArr[i] = arr.data[i + 1];
        }
        return dynArr;
    }
}
