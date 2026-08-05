/* eslint-disable */
const UUID = require('uuid-1345')
const minecraft = require('./minecraft')
const [Read, Write, SizeOf] = [{}, {}, {}]

/**
 * UUIDs
 */
Read.uuid = ['native', (buffer, offset) => {
  return {
    value: UUID.stringify(buffer.slice(offset, 16 + offset)),
    size: 16
  }
}]
Write.uuid = ['native', (value, buffer, offset) => {
  const buf = UUID.parse(value)
  buf.copy(buffer, offset)
  return offset + 16
}]
SizeOf.uuid = ['native', 16]

/**
 * Rest of buffer
 */
Read.restBuffer = ['native', (buffer, offset) => {
  return {
    value: buffer.slice(offset),
    size: buffer.length - offset
  }
}]
Write.restBuffer = ['native', (value, buffer, offset) => {
  value.copy(buffer, offset)
  return offset + value.length
}]
SizeOf.restBuffer = ['native', (value) => {
  return value.length
}]

/**
 * Encapsulated data with length prefix
 */
Read.encapsulated = ['parametrizable', (compiler, { lengthType, type }) => {
  return compiler.wrapCode(`
  const payloadSize = ${compiler.callType(lengthType, 'offset')}
  if (payloadSize.value === 0) {
    return { value: undefined, size: payloadSize.size }
  }
  const { value, size } = ctx.${type}(buffer, offset + payloadSize.size)
  return { value, size: size + payloadSize.size }
`.trim())
}]
Write.encapsulated = ['parametrizable', (compiler, { lengthType, type }) => {
  return compiler.wrapCode(`
  if (value === undefined) {
    return (ctx.${lengthType})(0, buffer, offset)
  }
  const buf = Buffer.allocUnsafe(buffer.length - offset)
  const payloadSize = (ctx.${type})(value, buf, 0)
  let size = (ctx.${lengthType})(payloadSize, buffer, offset)
  size += buf.copy(buffer, size, 0, payloadSize)
  return size
`.trim())
}]
SizeOf.encapsulated = ['parametrizable', (compiler, { lengthType, type }) => {
  return compiler.wrapCode(`
    if (value === undefined) {
      return (ctx.${lengthType})(0)
    }
    const payloadSize = (ctx.${type})(value)
    return (ctx.${lengthType})(payloadSize) + payloadSize
`.trim())
}]

/**
 * Read NBT until end of buffer or \0
 */
Read.nbtLoop = ['context', (buffer, offset) => {
  const values = []
  while (buffer[offset] != 0) {
    const n = ctx.nbt(buffer, offset)
    values.push(n.value)
    offset += n.size
  }
  return { value: values, size: buffer.length - offset }
}]
Write.nbtLoop = ['context', (value, buffer, offset) => {
  for (const val of value) {
    offset = ctx.nbt(val, buffer, offset)
  }
  buffer.writeUint8(0, offset)
  return offset + 1
}]
SizeOf.nbtLoop = ['context', (value, buffer, offset) => {
  let size = 1
  for (const val of value) {
    size += ctx.nbt(val, buffer, offset)
  }
  return size
}]

/**
 * Read rotation float encoded as a byte
 */
Read.byterot = ['context', (buffer, offset) => {
  const val = buffer.readUint8(offset)
  return { value: (val * (360 / 256)), size: 1 }
}]
Write.byterot = ['context', (value, buffer, offset) => {
  const val = (value / (360 / 256))
  buffer.writeUint8(val, offset)
  return offset + 1
}]
SizeOf.byterot = ['context', (value, buffer, offset) => {
  return 1
}]

/**
 * NBT
 */
Read.nbt = ['native', minecraft.nbt[0]]
Write.nbt = ['native', minecraft.nbt[1]]
SizeOf.nbt = ['native', minecraft.nbt[2]]

Read.lnbt = ['native', minecraft.lnbt[0]]
Write.lnbt = ['native', minecraft.lnbt[1]]
SizeOf.lnbt = ['native', minecraft.lnbt[2]]

/**
 * Bedrock 1.26.40 (network protocol 2168) player-auth-input helpers.
 *
 * The packet stopped using the legacy large bitflag value.  It now carries a
 * presence byte, a count, and signed VarInt enum ordinals.  The optional
 * payloads also carry a compatibility-presence byte followed by their actual
 * presence byte, in transaction, stack-request, block-action, and vehicle
 * order.  Keep the object shape used by the client's movement helper and
 * translate only at the wire boundary.
 */
const PLAYER_AUTH_INPUT_FLAGS = [
  'ascend',
  'descend',
  'north_jump',
  'jump_down',
  'sprint_down',
  'change_height',
  'jumping',
  'auto_jumping_in_water',
  'sneaking',
  'sneak_down',
  'up',
  'down',
  'left',
  'right',
  'up_left',
  'up_right',
  'want_up',
  'want_down',
  'want_down_slow',
  'want_up_slow',
  'sprinting',
  'ascend_block',
  'descend_block',
  'sneak_toggle_down',
  'persist_sneak',
  'start_sprinting',
  'stop_sprinting',
  'start_sneaking',
  'stop_sneaking',
  'start_swimming',
  'stop_swimming',
  'start_jumping',
  'start_gliding',
  'stop_gliding',
  'item_interact',
  'block_action',
  'item_stack_request',
  'handled_teleport',
  'emoting',
  'missed_swing',
  'start_crawling',
  'stop_crawling',
  'start_flying',
  'stop_flying',
  'received_server_data',
  'client_predicted_vehicle',
  'paddling_left',
  'paddling_right',
  'block_breaking_delay_enabled',
  'horizontal_collision',
  'vertical_collision',
  'down_left',
  'down_right',
  'start_using_item',
  'is_camera_relative_movement_enabled',
  'is_rot_controlled_by_move_direction',
  'start_spin_attack',
  'stop_spin_attack',
  'hotbar_only_touch',
  'jump_released_raw',
  'jump_pressed_raw',
  'jump_current_raw',
  'sneak_released_raw',
  'sneak_pressed_raw',
  'sneak_current_raw',
  'internal_update'
]

Read.PlayerAuthInputFlags = ['context', (buffer, offset) => {
  const flags = [
    'ascend', 'descend', 'north_jump', 'jump_down', 'sprint_down',
    'change_height', 'jumping', 'auto_jumping_in_water', 'sneaking', 'sneak_down',
    'up', 'down', 'left', 'right', 'up_left', 'up_right', 'want_up', 'want_down',
    'want_down_slow', 'want_up_slow', 'sprinting', 'ascend_block', 'descend_block',
    'sneak_toggle_down', 'persist_sneak', 'start_sprinting', 'stop_sprinting',
    'start_sneaking', 'stop_sneaking', 'start_swimming', 'stop_swimming',
    'start_jumping', 'start_gliding', 'stop_gliding', 'item_interact', 'block_action',
    'item_stack_request', 'handled_teleport', 'emoting', 'missed_swing', 'start_crawling',
    'stop_crawling', 'start_flying', 'stop_flying', 'received_server_data',
    'client_predicted_vehicle', 'paddling_left', 'paddling_right',
    'block_breaking_delay_enabled', 'horizontal_collision', 'vertical_collision',
    'down_left', 'down_right', 'start_using_item',
    'is_camera_relative_movement_enabled', 'is_rot_controlled_by_move_direction',
    'start_spin_attack', 'stop_spin_attack', 'hotbar_only_touch', 'jump_released_raw',
    'jump_pressed_raw', 'jump_current_raw', 'sneak_released_raw', 'sneak_pressed_raw',
    'sneak_current_raw', 'internal_update'
  ]
  let cursor = offset
  const value = {}
  for (const flag of flags) value[flag] = false

  const present = buffer[cursor++] !== 0
  if (!present) return { value, size: cursor - offset }

  const count = ctx.varint(buffer, cursor)
  cursor += count.size
  for (let index = 0; index < count.value; index += 1) {
    const ordinal = ctx.zigzag32(buffer, cursor)
    cursor += ordinal.size
    if (ordinal.value >= 0 && ordinal.value < flags.length) value[flags[ordinal.value]] = true
  }
  return { value, size: cursor - offset }
}]
Write.PlayerAuthInputFlags = ['context', (value, buffer, offset) => {
  let cursor = offset
  const flags = [
    'ascend', 'descend', 'north_jump', 'jump_down', 'sprint_down',
    'change_height', 'jumping', 'auto_jumping_in_water', 'sneaking', 'sneak_down',
    'up', 'down', 'left', 'right', 'up_left', 'up_right', 'want_up', 'want_down',
    'want_down_slow', 'want_up_slow', 'sprinting', 'ascend_block', 'descend_block',
    'sneak_toggle_down', 'persist_sneak', 'start_sprinting', 'stop_sprinting',
    'start_sneaking', 'stop_sneaking', 'start_swimming', 'stop_swimming',
    'start_jumping', 'start_gliding', 'stop_gliding', 'item_interact', 'block_action',
    'item_stack_request', 'handled_teleport', 'emoting', 'missed_swing', 'start_crawling',
    'stop_crawling', 'start_flying', 'stop_flying', 'received_server_data',
    'client_predicted_vehicle', 'paddling_left', 'paddling_right',
    'block_breaking_delay_enabled', 'horizontal_collision', 'vertical_collision',
    'down_left', 'down_right', 'start_using_item',
    'is_camera_relative_movement_enabled', 'is_rot_controlled_by_move_direction',
    'start_spin_attack', 'stop_spin_attack', 'hotbar_only_touch', 'jump_released_raw',
    'jump_pressed_raw', 'jump_current_raw', 'sneak_released_raw', 'sneak_pressed_raw',
    'sneak_current_raw', 'internal_update'
  ]
  const active = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]
    if (value && value[flag] === true) active.push(index)
  }

  buffer[cursor++] = 1
  cursor = ctx.varint(active.length, buffer, cursor)
  for (const ordinal of active) cursor = ctx.zigzag32(ordinal, buffer, cursor)
  return cursor
}]
SizeOf.PlayerAuthInputFlags = ['context', (value) => {
  const flags = [
    'ascend', 'descend', 'north_jump', 'jump_down', 'sprint_down',
    'change_height', 'jumping', 'auto_jumping_in_water', 'sneaking', 'sneak_down',
    'up', 'down', 'left', 'right', 'up_left', 'up_right', 'want_up', 'want_down',
    'want_down_slow', 'want_up_slow', 'sprinting', 'ascend_block', 'descend_block',
    'sneak_toggle_down', 'persist_sneak', 'start_sprinting', 'stop_sprinting',
    'start_sneaking', 'stop_sneaking', 'start_swimming', 'stop_swimming',
    'start_jumping', 'start_gliding', 'stop_gliding', 'item_interact', 'block_action',
    'item_stack_request', 'handled_teleport', 'emoting', 'missed_swing', 'start_crawling',
    'stop_crawling', 'start_flying', 'stop_flying', 'received_server_data',
    'client_predicted_vehicle', 'paddling_left', 'paddling_right',
    'block_breaking_delay_enabled', 'horizontal_collision', 'vertical_collision',
    'down_left', 'down_right', 'start_using_item',
    'is_camera_relative_movement_enabled', 'is_rot_controlled_by_move_direction',
    'start_spin_attack', 'stop_spin_attack', 'hotbar_only_touch', 'jump_released_raw',
    'jump_pressed_raw', 'jump_current_raw', 'sneak_released_raw', 'sneak_pressed_raw',
    'sneak_current_raw', 'internal_update'
  ]
  const active = []
  for (let index = 0; index < flags.length; index += 1) {
    if (value && value[flags[index]] === true) active.push(index)
  }
  let size = 1 + ctx.varint(active.length)
  for (const ordinal of active) size += ctx.zigzag32(ordinal)
  return size
}]

Read.PlayerAuthInputLegacy = ['context', (buffer, offset) => {
  let cursor = offset
  const request = ctx.zigzag32(buffer, cursor)
  cursor += request.size
  const hasSlots = buffer[cursor++] !== 0
  if (!hasSlots) return { value: { legacy_request_id: request.value, legacy_transactions: undefined }, size: cursor - offset }

  // The client never sends legacy slot changes, but consume the v2168 wire shape
  // when reading one so the following action fields remain aligned.
  const count = ctx.varint(buffer, cursor)
  cursor += count.size
  const slots = []
  for (let index = 0; index < count.value; index += 1) {
    const containerId = buffer[cursor++]
    const changed = ctx.ByteArray(buffer, cursor)
    cursor += changed.size
    slots.push({ container_id: containerId, changed_slots: changed.value })
  }
  return { value: { legacy_request_id: request.value, legacy_transactions: slots }, size: cursor - offset }
}]
Write.PlayerAuthInputLegacy = ['context', (value, buffer, offset) => {
  let cursor = ctx.zigzag32(Number(value?.legacy_request_id) || 0, buffer, offset)
  const slots = Array.isArray(value?.legacy_transactions) ? value.legacy_transactions : []
  const canWriteSlots = Number(value?.legacy_request_id) < -1 && (Number(value?.legacy_request_id) & 1) === 0 && slots.length > 0
  buffer[cursor++] = canWriteSlots ? 1 : 0
  if (canWriteSlots) {
    cursor = ctx.varint(slots.length, buffer, cursor)
    for (const slot of slots) {
      buffer[cursor++] = Number(slot.container_id) & 0xff
      cursor = ctx.ByteArray(slot.changed_slots || Buffer.alloc(0), buffer, cursor)
    }
  }
  return cursor
}]
SizeOf.PlayerAuthInputLegacy = ['context', (value) => {
  const request = Number(value?.legacy_request_id) || 0
  const slots = Array.isArray(value?.legacy_transactions) ? value.legacy_transactions : []
  const canWriteSlots = request < -1 && (request & 1) === 0 && slots.length > 0
  let size = ctx.zigzag32(request) + 1
  if (canWriteSlots) {
    size += ctx.varint(slots.length)
    for (const slot of slots) size += 1 + ctx.ByteArray(slot.changed_slots || Buffer.alloc(0))
  }
  return size
}]

Read.PlayerAuthInputTransaction = ['context', (buffer, offset) => {
  let cursor = offset
  const outerPresent = buffer[cursor++] !== 0
  const present = buffer[cursor++] !== 0
  if (!outerPresent || !present) return { value: undefined, size: cursor - offset }
  const legacy = ctx.PlayerAuthInputLegacy(buffer, cursor)
  cursor += legacy.size
  const actionsPresent = buffer[cursor++] !== 0
  const actionsEnabled = buffer[cursor++] !== 0
  let actions = []
  if (actionsPresent && actionsEnabled) {
    const result = ctx.TransactionActions(buffer, cursor)
    actions = result.value
    cursor += result.size
  }
  const data = ctx.TransactionUseItem(buffer, cursor)
  cursor += data.size
  return { value: { legacy: legacy.value, actions, data: data.value }, size: cursor - offset }
}]
Write.PlayerAuthInputTransaction = ['context', (value, buffer, offset) => {
  let cursor = offset
  buffer[cursor++] = 1
  const present = value !== undefined && value !== null
  buffer[cursor++] = present ? 1 : 0
  if (!present) return cursor

  cursor = ctx.PlayerAuthInputLegacy(value.legacy || { legacy_request_id: 0 }, buffer, cursor)
  buffer[cursor++] = 1
  buffer[cursor++] = 1
  cursor = ctx.TransactionActions(value.actions || [], buffer, cursor)
  cursor = ctx.TransactionUseItem(value.data, buffer, cursor)
  return cursor
}]
SizeOf.PlayerAuthInputTransaction = ['context', (value) => {
  if (value === undefined || value === null) return 2
  return 2 + ctx.PlayerAuthInputLegacy(value.legacy || { legacy_request_id: 0 }) + 2 +
    ctx.TransactionActions(value.actions || []) + ctx.TransactionUseItem(value.data)
}]

Read.PlayerAuthInputStackRequest = ['context', (buffer, offset) => {
  let cursor = offset
  const outerPresent = buffer[cursor++] !== 0
  const present = buffer[cursor++] !== 0
  if (!outerPresent || !present) return { value: undefined, size: cursor - offset }
  const result = ctx.ItemStackRequest(buffer, cursor)
  return { value: result.value, size: cursor - offset + result.size }
}]
Write.PlayerAuthInputStackRequest = ['context', (value, buffer, offset) => {
  let cursor = offset
  buffer[cursor++] = 1
  const present = value !== undefined && value !== null
  buffer[cursor++] = present ? 1 : 0
  if (present) cursor = ctx.ItemStackRequest(value, buffer, cursor)
  return cursor
}]
SizeOf.PlayerAuthInputStackRequest = ['context', (value) => 2 + (value === undefined || value === null ? 0 : ctx.ItemStackRequest(value))]

Read.PlayerAuthInputBlockActions = ['context', (buffer, offset) => {
  let cursor = offset
  const outerPresent = buffer[cursor++] !== 0
  const present = buffer[cursor++] !== 0
  if (!outerPresent || !present) return { value: undefined, size: cursor - offset }
  const count = ctx.varint(buffer, cursor)
  cursor += count.size
  const actions = []
  for (let index = 0; index < count.value; index += 1) {
    const action = ctx.Action(buffer, cursor)
    cursor += action.size
    const position = ctx.vec3i(buffer, cursor)
    cursor += position.size
    const face = ctx.zigzag32(buffer, cursor)
    cursor += face.size
    actions.push({ action: action.value, position: position.value, face: face.value })
  }
  return { value: actions, size: cursor - offset }
}]
Write.PlayerAuthInputBlockActions = ['context', (value, buffer, offset) => {
  let cursor = offset
  buffer[cursor++] = 1
  const present = Array.isArray(value)
  buffer[cursor++] = present ? 1 : 0
  if (!present) return cursor
  cursor = ctx.varint(value.length, buffer, cursor)
  for (const action of value) {
    cursor = ctx.Action(action.action, buffer, cursor)
    cursor = ctx.vec3i(action.position, buffer, cursor)
    cursor = ctx.zigzag32(action.face, buffer, cursor)
  }
  return cursor
}]
SizeOf.PlayerAuthInputBlockActions = ['context', (value) => {
  if (!Array.isArray(value)) return 2
  let size = 2 + ctx.varint(value.length)
  for (const action of value) size += ctx.Action(action.action) + ctx.vec3i(action.position) + ctx.zigzag32(action.face)
  return size
}]

Read.PlayerAuthInputOptionalVec2 = ['context', (buffer, offset) => {
  let cursor = offset
  const outerPresent = buffer[cursor++] !== 0
  const present = buffer[cursor++] !== 0
  if (!outerPresent || !present) return { value: undefined, size: cursor - offset }
  const result = ctx.vec2f(buffer, cursor)
  return { value: result.value, size: cursor - offset + result.size }
}]
Write.PlayerAuthInputOptionalVec2 = ['context', (value, buffer, offset) => {
  let cursor = offset
  buffer[cursor++] = 1
  const present = value !== undefined && value !== null
  buffer[cursor++] = present ? 1 : 0
  if (present) cursor = ctx.vec2f(value, buffer, cursor)
  return cursor
}]
SizeOf.PlayerAuthInputOptionalVec2 = ['context', (value) => 2 + (value === undefined || value === null ? 0 : ctx.vec2f(value))]

Read.PlayerAuthInputOptionalZigzag64 = ['context', (buffer, offset) => {
  let cursor = offset
  const outerPresent = buffer[cursor++] !== 0
  const present = buffer[cursor++] !== 0
  if (!outerPresent || !present) return { value: undefined, size: cursor - offset }
  const result = ctx.zigzag64(buffer, cursor)
  return { value: result.value, size: cursor - offset + result.size }
}]
Write.PlayerAuthInputOptionalZigzag64 = ['context', (value, buffer, offset) => {
  let cursor = offset
  buffer[cursor++] = 1
  const present = value !== undefined && value !== null
  buffer[cursor++] = present ? 1 : 0
  if (present) cursor = ctx.zigzag64(value, buffer, cursor)
  return cursor
}]
SizeOf.PlayerAuthInputOptionalZigzag64 = ['context', (value) => 2 + (value === undefined || value === null ? 0 : ctx.zigzag64(value))]

/**
 * Command Packet
 * - used for determining the size of the following enum
 */
Read.enum_size_based_on_values_len = ['parametrizable', (compiler) => {
  return compiler.wrapCode(js(() => {
    if (values_len <= 0xff) return { value: 'byte', size: 0 }
    if (values_len <= 0xffff) return { value: 'short', size: 0 }
    if (values_len <= 0xffffff) return { value: 'int', size: 0 }
  }))
}]
Write.enum_size_based_on_values_len = ['parametrizable', (compiler) => {
  return str(() => {
    if (value.values_len <= 0xff) _enum_type = 'byte'
    else if (value.values_len <= 0xffff) _enum_type = 'short'
    else if (value.values_len <= 0xffffff) _enum_type = 'int'
    return offset
  })
}]
SizeOf.enum_size_based_on_values_len = ['parametrizable', (compiler) => {
  return str(() => {
    if (value.values_len <= 0xff) _enum_type = 'byte'
    else if (value.values_len <= 0xffff) _enum_type = 'short'
    else if (value.values_len <= 0xffffff) _enum_type = 'int'
    return 0
  })
}]

function js (fn) {
  return fn.toString().split('\n').slice(1, -1).join('\n').trim()
}

function str (fn) {
  return fn.toString() + ')();(()=>{}'
}

module.exports = { Read, Write, SizeOf }
