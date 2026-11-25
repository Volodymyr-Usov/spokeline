# Spokeline's PermissionRequest hook on the Mac ("Approve by voice", off unless you switch it on).
# Claude Code runs it only when a permission box is about to be shown. It hands over to the Spokeline Ears
# helper inside this plugin (its source: ears/Sources/PermissionHook.swift in the repository). That helper
# acts only while "Approve by voice" is on and you are talking to this chat by voice: it hands the request
# to Spokeline, which reads it aloud, and waits a few seconds for your spoken "yes" or "no". With no spoken
# answer, or in any other case, it prints nothing and the normal permission box appears as usual.
# On Windows, permission-hook.mjs does the same job, and this file does nothing.
[ -x "${CLAUDE_PLUGIN_ROOT}/bin/SpokelineEars.app/Contents/MacOS/SpokelineEars" ] || exit 0
exec "${CLAUDE_PLUGIN_ROOT}/bin/SpokelineEars.app/Contents/MacOS/SpokelineEars" --permission-hook
