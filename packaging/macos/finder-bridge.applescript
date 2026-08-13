on launchPdf(pdfItem)
	set appRoot to POSIX path of (path to me)
	set launcherPath to appRoot & "Contents/MacOS/pdf-proofreader"
	set pdfPath to POSIX path of pdfItem
	try
		set launchCommand to (quoted form of launcherPath) & space & (quoted form of pdfPath)
		do shell script launchCommand
	on error errorMessage number errorNumber
		if errorNumber is not -128 then
			display alert "Placekeeper could not open this file" message errorMessage buttons {"OK"} default button 1
		end if
	end try
end launchPdf

on open pdfItems
	if (count of pdfItems) is not 1 then
		display alert "Choose one PDF" message "Placekeeper opens one local PDF at a time." buttons {"Choose one PDF"} default button 1
		return
	end if
	launchPdf(item 1 of pdfItems)
end open

on run
	try
		set pdfItem to choose file of type {"com.adobe.pdf"} with prompt "Choose one local PDF to read or annotate"
		launchPdf(pdfItem)
	on error errorMessage number errorNumber
		if errorNumber is not -128 then error errorMessage number errorNumber
	end try
end run
