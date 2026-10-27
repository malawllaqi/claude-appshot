-- AppShot for Hammerspoon: capture the frontmost window (image + Accessibility
-- text) and drop it into an inbox the Claude "appshot" mod picks up.
--
-- Install: copy this file to ~/.hammerspoon/appshot.lua and add to init.lua:
--   appshot = require("appshot")
--   appshot.start()
--
-- Triggers:
--   * press both Command keys together (left + right)
--   * ctrl+alt+cmd+A (fallback hotkey, see M.config.hotkey)
--   * hammerspoon://appshot            (what the mod's /appshot command opens)
--
-- Permissions (System Settings > Privacy & Security), granted to Hammerspoon:
--   * Accessibility                 to read window text and watch the Command keys
--   * Screen & System Audio Recording  to capture the window image

local M = {}

M.config = {
  root = os.getenv("HOME") .. "/Library/Application Support/AppShot",
  doubleCommand = true,
  hotkey = { mods = { "ctrl", "alt", "cmd" }, key = "a" },
  -- Bring Claude forward after a capture, the way Codex brings itself up.
  focusClaude = true,
  claudeBundleID = "com.anthropic.claudefordesktop",
  -- Longest side of the saved PNG, in pixels (keeps Retina captures small).
  maxImageSide = 2000,
  -- Limits on the Accessibility walk, so a huge window never hangs the capture.
  maxTextChars = 200000,
  maxElements = 8000,
  maxDepth = 60,
  textSeconds = 2.5,
}

-- Device-dependent bits of the raw modifier flags (IOKit's NX_DEVICE*CMDKEYMASK).
local LEFT_CMD = 0x08
local RIGHT_CMD = 0x10

local TEXT_ROLES = {
  AXStaticText = true, AXTextArea = true, AXTextField = true, AXHeading = true,
  AXLink = true, AXCell = true, AXMenuButton = true, AXButton = true,
  AXCheckBox = true, AXRadioButton = true, AXPopUpButton = true, AXTab = true,
}

local function log(...) print("[appshot]", ...) end

local function mkdirp(path)
  local sofar = ""
  for part in path:gmatch("[^/]+") do
    sofar = sofar .. "/" .. part
    if not hs.fs.attributes(sofar, "mode") then hs.fs.mkdir(sofar) end
  end
end

local function writeFile(path, text)
  local f = assert(io.open(path, "w"))
  f:write(text)
  f:close()
end

local function shellQuote(s) return "'" .. s:gsub("'", "'\\''") .. "'" end

local function newId()
  return os.date("%Y%m%d-%H%M%S") .. string.format("-%04x", math.random(0, 0xffff))
end

local function isClaude(win)
  local app = win and win:application()
  return app ~= nil and app:bundleID() == M.config.claudeBundleID
end

-- The window to capture: the frontmost one, or the topmost non-Claude window
-- when Claude itself is in front (as when /appshot is typed in Claude).
local function targetWindow()
  local front = hs.window.frontmostWindow()
  if front and not isClaude(front) and front:isVisible() then return front end
  for _, win in ipairs(hs.window.orderedWindows()) do
    if not isClaude(win) and win:isStandard() and win:isVisible() then return win end
  end
  return nil
end

local function stringAttr(el, name)
  local ok, v = pcall(el.attributeValue, el, name)
  if ok and type(v) == "string" and v:match("%S") then return v end
  return nil
end

-- Chromium and Electron apps expose their tree only once asked to.
local function enableAppAccessibility(app)
  local axApp = hs.axuielement.applicationElement(app)
  if axApp then
    pcall(axApp.setAttributeValue, axApp, "AXManualAccessibility", true)
    pcall(axApp.setAttributeValue, axApp, "AXEnhancedUserInterface", true)
  end
end

-- Walks the window's Accessibility tree depth-first, in reading order, and
-- returns its visible-or-scrolled text plus any URL or document it names.
-- A web page's text (inside an AXWebArea) comes first, the app's own
-- controls (toolbars, tab strips) after it.
local function windowText(win)
  local cfg = M.config
  local root = hs.axuielement.windowElement(win)
  if not root then return "", {} end

  local deadline = hs.timer.secondsSinceEpoch() + cfg.textSeconds
  local page, controls, total, seen, last = {}, {}, 0, 0, nil
  local found = { url = nil, document = stringAttr(root, "AXDocument") }
  local stack = { { root, 0, false } }
  local isTruncated = false

  while #stack > 0 do
    if seen >= cfg.maxElements or total >= cfg.maxTextChars
      or hs.timer.secondsSinceEpoch() > deadline then
      isTruncated = true
      break
    end
    local el, depth, inWeb = table.unpack(table.remove(stack))
    seen = seen + 1

    local role = stringAttr(el, "AXRole")
    if role == "AXWebArea" then inWeb = true end
    if role == "AXWebArea" and not found.url then
      local ok, url = pcall(el.attributeValue, el, "AXURL")
      if ok and url then found.url = type(url) == "table" and url.url or tostring(url) end
    end
    if role and TEXT_ROLES[role] then
      local text = stringAttr(el, "AXValue") or stringAttr(el, "AXTitle")
        or stringAttr(el, "AXDescription")
      if text and text ~= last then
        local lines = inWeb and page or controls
        lines[#lines + 1] = text
        total = total + #text + 1
        last = text
      end
    end

    if depth < cfg.maxDepth then
      local ok, children = pcall(el.attributeValue, el, "AXChildren")
      if ok and type(children) == "table" then
        for i = #children, 1, -1 do stack[#stack + 1] = { children[i], depth + 1, inWeb } end
      end
    end
  end

  local text = table.concat(page, "\n")
  if #page > 0 and #controls > 0 then
    text = text .. "\n\n--- window controls ---\n" .. table.concat(controls, "\n")
  elseif #controls > 0 then
    text = table.concat(controls, "\n")
  end
  if #text > cfg.maxTextChars then text = text:sub(1, cfg.maxTextChars) end
  found.isTextTruncated = isTruncated
  return text, found
end

local function saveImage(win, path)
  local img = win:snapshot()
  if not img then return nil end
  if not img:saveToFile(path) then return nil end
  local side = M.config.maxImageSide
  hs.execute("/usr/bin/sips -Z " .. side .. " " .. shellQuote(path) .. " >/dev/null 2>&1")
  -- hs.image sizes are in points; the model wants the file's pixels.
  local info = hs.execute("/usr/bin/sips -g pixelWidth -g pixelHeight " .. shellQuote(path))
  local w, h = info:match("pixelWidth: (%d+)"), info:match("pixelHeight: (%d+)")
  if w and h then return { w = tonumber(w), h = tonumber(h) } end
  return img:size()
end

function M.capture(trigger)
  local win = targetWindow()
  if not win then
    hs.alert.show("Appshot: no window to capture")
    return nil
  end
  local app = win:application()
  local cfg = M.config
  local id = newId()
  local staging = cfg.root .. "/staging/" .. id
  local inbox = cfg.root .. "/inbox"
  mkdirp(staging)
  mkdirp(inbox)

  local imagePath = staging .. "/shot.png"
  local size = saveImage(win, imagePath)
  if not size then
    hs.alert.show("Appshot: could not capture the window.\nGrant Hammerspoon Screen Recording.")
    log("snapshot failed; screen recording permission is probably missing")
  end

  if app then enableAppAccessibility(app) end
  local okText, text, found = pcall(windowText, win)
  if not okText then
    log("text walk failed:", text)
    text, found = "", {}
  end
  writeFile(staging .. "/text.txt", text)

  local frame = win:frame()
  local meta = {
    id = id,
    version = 1,
    trigger = trigger or "hotkey",
    capturedAt = math.floor(hs.timer.secondsSinceEpoch() * 1000),
    app = app and app:name() or "Unknown app",
    bundleID = app and app:bundleID() or nil,
    title = win:title() or "",
    url = found.url,
    document = found.document,
    image = size and "shot.png" or nil,
    imageWidth = size and math.floor(size.w) or nil,
    imageHeight = size and math.floor(size.h) or nil,
    text = "text.txt",
    textChars = #text,
    isTextTruncated = found.isTextTruncated or false,
    window = { x = frame.x, y = frame.y, w = frame.w, h = frame.h },
  }
  -- meta.json last, then one rename: the mod never sees a half-written capture.
  writeFile(staging .. "/meta.json", hs.json.encode(meta, true))
  local ok, err = os.rename(staging, inbox .. "/" .. id)
  if not ok then
    hs.alert.show("Appshot: could not save the capture")
    log("rename failed:", err)
    return nil
  end

  hs.alert.show("Appshot: " .. meta.app .. (meta.title ~= "" and (" — " .. meta.title) or ""), 1.2)
  if cfg.focusClaude and trigger ~= "url" then
    hs.application.launchOrFocusByBundleID(cfg.claudeBundleID)
  end
  return id
end

local function startDoubleCommand()
  local bothDown = false
  M._flagsTap = hs.eventtap.new({ hs.eventtap.event.types.flagsChanged }, function(event)
    local raw = event:rawFlags()
    local flags = event:getFlags()
    local both = (raw & LEFT_CMD) ~= 0 and (raw & RIGHT_CMD) ~= 0
    local onlyCmd = flags.cmd and not (flags.alt or flags.ctrl or flags.shift or flags.fn)
    if both and onlyCmd and not bothDown then
      bothDown = true
      hs.timer.doAfter(0, function() M.capture("double-command") end)
    elseif not both then
      bothDown = false
    end
    return false
  end)
  M._flagsTap:start()
  -- macOS disables a tap that ever runs slow; keep it on.
  M._tapWatchdog = hs.timer.doEvery(5, function()
    if M._flagsTap and not M._flagsTap:isEnabled() then M._flagsTap:start() end
  end)
end

function M.start()
  math.randomseed(os.time())
  mkdirp(M.config.root .. "/inbox")
  if M.config.doubleCommand then startDoubleCommand() end
  if M.config.hotkey then
    M._hotkey = hs.hotkey.bind(M.config.hotkey.mods, M.config.hotkey.key, function()
      M.capture("hotkey")
    end)
  end
  -- The mod's /appshot runs `open -g hammerspoon://appshot`; Claude is already in front.
  hs.urlevent.bind("appshot", function() M.capture("url") end)
  log("ready; inbox at " .. M.config.root .. "/inbox")
  return M
end

function M.stop()
  if M._flagsTap then M._flagsTap:stop() end
  if M._tapWatchdog then M._tapWatchdog:stop() end
  if M._hotkey then M._hotkey:delete() end
  hs.urlevent.bind("appshot", nil)
end

return M
