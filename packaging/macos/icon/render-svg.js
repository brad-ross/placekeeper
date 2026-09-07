ObjC.import("AppKit");
ObjC.import("Foundation");

const arguments = $.NSProcessInfo.processInfo.arguments;
const source = ObjC.unwrap(arguments.objectAtIndex(4));
const output = ObjC.unwrap(arguments.objectAtIndex(5));
const pixels = Number(ObjC.unwrap(arguments.objectAtIndex(6)));
const image = $.NSImage.alloc.initWithContentsOfFile(source);
if (image.isNil()) throw new Error(`Could not read SVG: ${source}`);

const bitmap = $.NSBitmapImageRep.alloc
  .initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null,
    pixels,
    pixels,
    8,
    4,
    true,
    false,
    $.NSDeviceRGBColorSpace,
    0,
    0,
  );
bitmap.size = $.NSMakeSize(pixels, pixels);

const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
$.NSGraphicsContext.saveGraphicsState;
$.NSGraphicsContext.setCurrentContext(context);
image.drawInRectFromRectOperationFraction(
  $.NSMakeRect(0, 0, pixels, pixels),
  $.NSZeroRect,
  $.NSCompositingOperationCopy,
  1,
);
$.NSGraphicsContext.restoreGraphicsState;

const data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
if (!data.writeToFileAtomically(output, true)) throw new Error(`Could not write PNG: ${output}`);
