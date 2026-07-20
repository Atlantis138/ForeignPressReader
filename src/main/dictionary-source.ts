export const ECDICT_COMMIT = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b'
export const ECDICT_CSV_SIZE = 65_933_428
export const ECDICT_CSV_BLOB_SHA = 'c4ade63ea08cf39d9c3475e96929036d64d94c94'
export const ECDICT_LEMMA_SIZE = 2_318_694
export const ECDICT_LEMMA_BLOB_SHA = '34eabb9f48c5867a91c01c33b206120e275f0418'

const source = `https://raw.githubusercontent.com/skywind3000/ECDICT/${ECDICT_COMMIT}`

export const ECDICT_DOWNLOAD_BASES = [
  source,
  `https://ghproxy.net/${source}`,
  `https://ghfast.top/${source}`,
] as const
