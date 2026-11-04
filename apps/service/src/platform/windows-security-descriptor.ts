// File ACL updates may set SE_DACL_AUTO_INHERITED without changing any ACE.
// Ignore only that marker in memory; retain every other control flag and byte.
// https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/security-descriptor-control
export const WINDOWS_REPLACEMENT_SECURITY_SOURCE = String.raw`
public static class PlacekeeperReplacementSecurity {
 private static byte[] Comparable(byte[] bytes) {
  var descriptor = new System.Security.AccessControl.RawSecurityDescriptor(bytes, 0);
  descriptor.SetFlags(descriptor.ControlFlags & ~System.Security.AccessControl.ControlFlags.DiscretionaryAclAutoInherited);
  var normalized = new byte[descriptor.BinaryLength];
  descriptor.GetBinaryForm(normalized, 0);
  return normalized;
 }
 public static bool Equivalent(byte[] expected, byte[] actual) {
  var left = Comparable(expected); var right = Comparable(actual);
  if (left.Length != right.Length) return false;
  for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
  return true;
 }
}`;
