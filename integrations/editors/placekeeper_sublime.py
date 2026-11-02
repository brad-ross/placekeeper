"""Unverified Sublime Text command recipe; configure the three project settings first."""
import subprocess
import sublime
import sublime_plugin


class PlacekeeperForwardSyncTexCommand(sublime_plugin.TextCommand):
    def run(self, edit):
        settings = self.view.settings()
        launcher = settings.get("placekeeper_launcher")
        pdf = settings.get("placekeeper_pdf")
        session = settings.get("placekeeper_session")
        source = self.view.file_name()
        if not all((launcher, pdf, session, source)) or not self.view.sel():
            sublime.error_message("Set placekeeper_launcher, placekeeper_pdf, and placekeeper_session, then save the LaTeX buffer.")
            return
        line = self.view.rowcol(self.view.sel()[0].begin())[0] + 1
        argv = [launcher, "forward-search", "--pdf", pdf, "--source", source, "--line", str(line), "--session", session]

        def navigate():
            try:
                result = subprocess.run(argv, capture_output=True, text=True, timeout=15, check=False)
                if result.returncode:
                    message = result.stderr or "Placekeeper navigation failed."
                    sublime.set_timeout(lambda: sublime.error_message(message))
            except (OSError, subprocess.TimeoutExpired) as error:
                message = "Placekeeper: " + str(error)
                sublime.set_timeout(lambda: sublime.error_message(message))

        sublime.set_timeout_async(navigate)
