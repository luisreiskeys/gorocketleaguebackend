/**
 * H3: célula do usuário = resUserCell, sala = resRoomCell (célula pai).
 * Resoluções vêm de config/h3Resolutions (env H3_RES_USER_CELL, H3_RES_ROOM_CELL).
 */
const { latLngToCell, cellToParent } = require("h3-js");
const { resUserCell, resRoomCell } = require("../config/h3Resolutions");

function latLngToUserCell(lat, lng) {
  return latLngToCell(lat, lng, resUserCell);
}

function userCellToRoomCell(h3UserCellIndex) {
  return cellToParent(h3UserCellIndex, resRoomCell);
}

module.exports = {
  resUserCell,
  resRoomCell,
  latLngToUserCell,
  userCellToRoomCell,
};
