const baseUsernames = [
  "SwiftFox", "DarkRex", "NeoRider", "SkyNomad", "IronPath",
  "NovaRex", "LoneWolf", "ZenScout", "HexRider", "FluxFox",
  "BlazeX", "CryoFox", "Solaris", "NightRex", "StormX",
  "FrostX", "WildHex", "RuneFox", "EchoRex", "VexRider",
  "MythX", "AeroFox", "BoltRex", "DriftX", "ZedNomad",
  "NeoScout", "SkyRex", "IronHex", "NovaFox", "LunaX",
  "VoidRex", "ZenRider", "HexScout", "FluxRex", "BlitzX",
  "CryoRex", "SolarFox", "NightX", "StormFox", "FrostRex",
  "WildRex", "RuneX", "EchoFox", "VexNomad", "MythFox",
  "AeroRex", "BoltX", "DriftFox", "ZedRex", "NeoFox",
  "SkyHex", "IronRex", "NovaX", "LoneRex", "ZenFox",
  "HexNomad", "FluxX", "BlazeFox", "CryoX", "SolarRex",
  "NightFox", "StormRex", "FrostFox", "WildFox", "RuneRex",
  "EchoX", "VexFox", "MythRex", "AeroX", "BoltFox",
  "DriftRex", "ZedFox", "NeoX", "SkyFox", "IronX",
  "NovaHex", "LunaRex", "VoidFox", "ZenX", "HexFox",
  "FluxNomad", "BlitzFox", "CryoNomad", "SolarX", "NightHex",
  "StormHex", "FrostHex", "WildX", "RuneHex", "EchoHex",
  "VexHex", "MythHex", "AeroHex", "BoltHex", "DriftHex",
  "ZedHex", "NovaRider",
];

function getNewUsername() {
  const base = baseUsernames[Math.floor(Math.random() * baseUsernames.length)];
  const number = Math.floor(Math.random() * 990) + 10; // 10–999
  return `${base}${number}`;
}

module.exports = { getNewUsername };
