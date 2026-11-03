local M = {}
local configuration, session, association

local function run(argv)
  local ok, result = pcall(function() return vim.system(argv, { text = true }):wait(15000) end)
  if not ok then error("Placekeeper: " .. tostring(result)) end
  if result.code ~= 0 then error(result.stderr ~= "" and result.stderr or "Placekeeper command failed") end
  return (result.stdout or ""):gsub("%s+$", "")
end

local function token(value)
  if #value ~= 43 or value:find("[^%w_-]") then error("Placekeeper returned an invalid session or association") end
  return value
end

function M.setup(options)
  assert(type(options) == "table", "Placekeeper setup needs explicit launcher, source_root, and pdf paths")
  local config = {}
  for key, value in pairs(options) do config[key] = value end
  for _, key in ipairs({ "launcher", "source_root", "pdf" }) do
    assert(type(config[key]) == "string" and config[key]:sub(1, 1) == "/", key .. " must be an absolute path")
  end
  config.profile = config.profile or "neovim"
  config.follow_after_build = config.follow_after_build == true
  configuration, session, association = config, nil, nil
end

function M.register()
  assert(configuration, "Call Placekeeper setup first")
  local socket = configuration.socket or vim.v.servername
  assert(type(socket) == "string" and socket:sub(1, 1) == "/", "Neovim needs a local listening socket")
  local next_session = token(run({ configuration.launcher, "editor", "register", "--profile", configuration.profile,
    "--source-root", configuration.source_root, "--socket", socket }))
  session, association = next_session, nil
  return session
end

local function location()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local source = vim.api.nvim_buf_get_name(0)
  assert(source ~= "", "Save the LaTeX buffer before navigating")
  return { source = source, line = cursor[1], column = cursor[2] + 1 }
end

local function forward_args(config, registered, position)
  local argv = { config.launcher, "forward-search", "--pdf", config.pdf, "--source", position.source,
    "--line", tostring(position.line), "--column", tostring(position.column), "--session", registered }
  if config.synctex_directory then
    table.insert(argv, "--synctex-directory")
    table.insert(argv, config.synctex_directory)
  end
  return argv
end

function M.forward()
  assert(configuration, "Call Placekeeper setup first")
  if not session then M.register() end
  local argv = forward_args(configuration, session, location())
  table.insert(argv, "--intent")
  table.insert(argv, "explicit")
  association = token(run(argv))
  return association
end

function M.capture_build()
  if not configuration or not configuration.follow_after_build or not session or not association then return nil end
  return { configuration = configuration, session = session, association = association, position = location() }
end

function M.build_finished(captured, succeeded)
  if not succeeded or not captured or captured.configuration ~= configuration or not configuration.follow_after_build then return end
  local argv = forward_args(captured.configuration, captured.session, captured.position)
  table.insert(argv, "--intent")
  table.insert(argv, "follow")
  table.insert(argv, "--association")
  table.insert(argv, captured.association)
  local ok, result = pcall(run, argv)
  if not ok and not tostring(result):find("Follow request is stale", 1, true) then
    vim.notify(tostring(result), vim.log.levels.WARN)
  end
end

return M
