/* Native entry point for the bundled Node launcher. No PATH lookup or shell. */
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

/* Microsoft CRT quoting: double backslashes before a quote or closing quote. */
static wchar_t *append_argument(wchar_t *output, const wchar_t *argument) {
  *output++ = L'"';
  while (*argument) {
    size_t slashes = 0;
    while (*argument == L'\\') { slashes++; argument++; }
    if (*argument == L'"' || !*argument) {
      for (size_t i = 0; i < slashes * 2; i++) *output++ = L'\\';
      if (*argument == L'"') *output++ = L'\\';
    } else {
      for (size_t i = 0; i < slashes; i++) *output++ = L'\\';
    }
    if (*argument) *output++ = *argument++;
  }
  *output++ = L'"';
  *output++ = L' ';
  return output;
}

int wmain(int argc, wchar_t **argv) {
  wchar_t module[32768];
  DWORD length = GetModuleFileNameW(NULL, module, 32768);
  if (!length || length >= 32768) return 2;
  wchar_t *separator = wcsrchr(module, L'\\');
  if (!separator) return 2;
  *separator = L'\0';
  wchar_t node[32768], launcher[32768];
  if (swprintf_s(node, 32768, L"%ls\\..\\node\\bin\\node.exe", module) < 0 ||
      swprintf_s(launcher, 32768, L"%ls\\..\\launcher.mjs", module) < 0) return 2;
  #ifdef VSCODE_EXTERNAL
  if (swprintf_s(launcher, 32768, L"%ls\\..\\vscode-launcher.mjs", module) < 0) return 2;
#endif
  size_t capacity = (wcslen(node) + wcslen(launcher) + 64) * 2;
  for (int i = 1; i < argc; i++) capacity += wcslen(argv[i]) * 2 + 4;
  wchar_t *command = calloc(capacity, sizeof(wchar_t));
  if (!command) return 2;
  wchar_t *cursor = append_argument(command, node);
  cursor = append_argument(cursor, launcher);
#ifdef CHROME_NATIVE_HOST
  cursor = append_argument(cursor, L"chrome-native-host");
#endif
  for (int i = 1; i < argc; i++) cursor = append_argument(cursor, argv[i]);
  cursor[-1] = L'\0';
  STARTUPINFOW startup = {0};
  PROCESS_INFORMATION process = {0};
  startup.cb = (DWORD)sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  BOOL created = CreateProcessW(node, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &process);
  free(command);
  if (!created) { fwprintf(stderr, L"Placekeeper bundled launcher failed (%lu)\n", GetLastError()); return 2; }
  CloseHandle(process.hThread);
  DWORD exit_code = 2;
  if (WaitForSingleObject(process.hProcess, INFINITE) == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);
  return (int)exit_code;
}
#else
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

int main(int argc, char **argv) {
  char executable[65536];
#ifdef __APPLE__
  uint32_t capacity = sizeof(executable);
  if (_NSGetExecutablePath(executable, &capacity) != 0) return 2;
#else
  ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
  if (length < 0 || (size_t)length >= sizeof(executable) - 1) return 2;
  executable[length] = '\0';
#endif
  char *physical = realpath(executable, NULL);
  if (!physical) { perror("Placekeeper launcher location"); return 2; }
  char *separator = strrchr(physical, '/');
  if (!separator) { free(physical); return 2; }
  *separator = '\0';
  size_t capacity_paths = strlen(physical) + 32;
  char *node = malloc(capacity_paths), *launcher = malloc(capacity_paths);
  char **arguments = calloc((size_t)argc + 4, sizeof(char *));
  if (!node || !launcher || !arguments) { free(physical); free(node); free(launcher); free(arguments); return 2; }
  snprintf(node, capacity_paths, "%s/../node/bin/node", physical);
  snprintf(launcher, capacity_paths, "%s/../launcher.mjs", physical);
#ifdef VSCODE_EXTERNAL
  snprintf(launcher, capacity_paths, "%s/../vscode-launcher.mjs", physical);
#endif
  int next = 0;
  arguments[next++] = node;
  arguments[next++] = launcher;
#ifdef CHROME_NATIVE_HOST
  arguments[next++] = "chrome-native-host";
#endif
  for (int i = 1; i < argc; i++) arguments[next++] = argv[i];
  execv(node, arguments);
  perror("Placekeeper bundled launcher");
  free(physical); free(node); free(launcher); free(arguments);
  return 2;
}
#endif
