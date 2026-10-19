import { listCompactPacks } from './compact-packs.js'

export function listRolePresets() {
  return listCompactPacks().map((pack) => ({
    id: pack.key,
    name: pack.label,
    label: pack.label,
    description: pack.description,
    compactPackKey: pack.key,
    workMode: pack.workMode,
    roles: pack.roles,
    activePackRoles: pack.roles.map((role) => role.key),
  }))
}
