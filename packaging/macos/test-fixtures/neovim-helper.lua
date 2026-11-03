local calls, responses, notices = {}, {}, {}
local source = "/project with spaces/chapters/a'$`;.tex"
vim = {
  v = { servername = "/tmp/neovim socket" },
  api = { nvim_win_get_cursor = function() return { 17, 2 } end, nvim_buf_get_name = function() return source end },
  system = function(argv, options)
    assert(options.text == true)
    table.insert(calls, argv)
    return { wait = function(_, timeout)
      assert(timeout == 15000)
      return { code = 0, stdout = assert(table.remove(responses, 1)) .. "\n", stderr = "" }
    end }
  end,
  notify = function(message) table.insert(notices, message) end,
  log = { levels = { WARN = 2 } },
}
local helper = dofile(assert(arg[1]))
local function configure(follow)
  helper.setup({ launcher = "/installed app/placekeeper", source_root = "/project with spaces", pdf = "/build dir/main.pdf",
    synctex_directory = "/mapping dir", follow_after_build = follow })
end
local function option(argv, key)
  for index, value in ipairs(argv) do if value == key then return argv[index + 1] end end
end
configure(false)
responses = { string.rep("s", 43), string.rep("a", 43) }
assert(helper.forward() == string.rep("a", 43))
assert(#calls == 2)
assert(option(calls[1], "--socket") == "/tmp/neovim socket")
assert(option(calls[2], "--source") == source)
assert(option(calls[2], "--line") == "17" and option(calls[2], "--column") == "3")
assert(option(calls[2], "--intent") == "explicit")
assert(option(calls[2], "--synctex-directory") == "/mapping dir")
assert(helper.capture_build() == nil)
configure(true)
responses = { string.rep("s", 43), string.rep("a", 43), string.rep("b", 43), string.rep("a", 43) }
helper.forward()
local captured = assert(helper.capture_build())
source = "/another-chapter.tex"
helper.forward()
helper.build_finished(captured, true)
local follow = calls[#calls]
assert(option(follow, "--association") == string.rep("a", 43))
assert(option(follow, "--intent") == "follow")
assert(option(follow, "--source") == "/project with spaces/chapters/a'$`;.tex")
assert(helper.capture_build().association == string.rep("b", 43))
local count = #calls
helper.build_finished(captured, false)
assert(#calls == count)
configure(true)
helper.build_finished(captured, true)
assert(#calls == count)
assert(helper.capture_build() == nil)
assert(#notices == 0)
print("helper checks passed")
