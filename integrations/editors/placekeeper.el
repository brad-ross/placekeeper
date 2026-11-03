;;; placekeeper.el --- Unverified local SyncTeX command recipe -*- lexical-binding: t; -*-

(defvar placekeeper-launcher nil "Absolute path to the installed Placekeeper launcher.")
(defvar placekeeper-pdf nil "Absolute path to the project's root PDF, including for chapter buffers.")
(defvar placekeeper-session nil "Session handle returned by Placekeeper editor register.")

(defun placekeeper-forward-sync-tex ()
  "Reveal the current source line in the native Placekeeper viewer."
  (interactive)
  (unless (and placekeeper-launcher placekeeper-pdf placekeeper-session buffer-file-name)
    (user-error "Set the Placekeeper launcher, root PDF and session, then save this file"))
  (let* ((output (get-buffer-create "*Placekeeper*"))
         (status (call-process placekeeper-launcher nil output nil
                               "forward-search" "--pdf" placekeeper-pdf
                               "--source" buffer-file-name
                               "--line" (number-to-string (line-number-at-pos nil t))
                               "--session" placekeeper-session)))
    (unless (eq status 0) (display-buffer output))))

(provide 'placekeeper)
