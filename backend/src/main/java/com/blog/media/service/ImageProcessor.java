package com.blog.media.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.media.config.MediaProperties;
import com.drew.imaging.jpeg.JpegMetadataReader;
import com.drew.imaging.png.PngChunk;
import com.drew.imaging.png.PngChunkReader;
import com.drew.imaging.png.PngChunkType;
import com.drew.imaging.riff.RiffHandler;
import com.drew.imaging.riff.RiffReader;
import com.drew.lang.ByteArrayReader;
import com.drew.lang.SequentialByteArrayReader;
import com.drew.metadata.Metadata;
import com.drew.metadata.exif.ExifIFD0Directory;
import com.drew.metadata.exif.ExifReader;
import com.drew.metadata.exif.ExifSubIFDDirectory;
import com.twelvemonkeys.image.ResampleOp;
import com.twelvemonkeys.imageio.stream.ByteArrayImageInputStream;
import java.awt.AlphaComposite;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Transparency;
import java.awt.color.ColorSpace;
import java.awt.color.ICC_ColorSpace;
import java.awt.color.ICC_Profile;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.awt.image.ColorConvertOp;
import java.awt.image.ColorModel;
import java.awt.image.ComponentColorModel;
import java.awt.image.DataBuffer;
import java.awt.image.DataBufferInt;
import java.awt.image.IndexColorModel;
import java.awt.image.Raster;
import java.awt.image.WritableRaster;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.DateTimeException;
import java.time.LocalDate;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.InflaterInputStream;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReadParam;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.plugins.jpeg.JPEGImageWriteParam;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;

/**
 * Turns an image file uploaded by a user into a safe image to store and serve publicly.
 *
 * The steps run cheap-first: magic bytes (a few bytes), EXIF (only the EXIF block) and the PNG color profile (only the
 * iCCP chunk), size and frame structure from the header (no decoding yet), and only then the decode. The earlier an
 * image is rejected the less memory it costs, and a "bomb" image (a header that declares 100 MP, or 50,000,000x1, or a
 * lossless JPEG of 7000x7000 in a file of a few hundred bytes) never reaches the decode step.
 *
 * The output is always re-encoded from the pixels, never the bytes of the original file. That is what strips EXIF/GPS,
 * and what breaks "polyglot" files (valid images that are also HTML/SVG).
 *
 * A pure class: it needs no Spring context to run (tests build it directly with {@code new}), and it has no state
 * beyond its configuration, so it can be shared between threads. Limiting how many images are processed at once is the
 * job of MediaService (a semaphore), not of this class.
 */
public class ImageProcessor {

    private static final Logger log = LoggerFactory.getLogger(ImageProcessor.class);

    /** Shrink loop when the encoded image still exceeds the ceiling: each pass x0.8, never below 800px on the long edge. */
    private static final double SHRINK_FACTOR = 0.8;

    private static final int MIN_EDGE = 800;

    /**
     * The longest edge a header may declare, in addition to the width x height limit. 65,535 is the largest edge a JPEG
     * can declare (WebP is lower, 16,383); only PNG can declare up to 2^31 - 1. The JDK PNG reader allocates three
     * full-width one-row buffers before reading any pixel, even when decoding with subsampling: a PNG of a few dozen
     * bytes that declares 50,000,000x1 (exactly 50 MP) was measured to need 200-300 MB and ends in an OutOfMemoryError
     * within the 364 MB heap of the container. At 65,535 pixels, those three buffers are at most ~1.5 MB.
     */
    private static final int MAX_SIDE = 65_535;

    /**
     * Ceiling of the DCT coefficient buffer of a progressive or multi-scan JPEG. For such images libjpeg keeps the
     * coefficients of the WHOLE IMAGE in native memory, outside the heap, and subsampled decoding cannot reduce it: 2
     * bytes per coefficient, i.e. 3 bytes per pixel with 4:2:0 and 6 bytes with 4:4:4. Measured: a progressive 4:4:4
     * 8160x6120 JPEG of only 879 KB made the process allocate an extra ~287 MB natively, enough for the kernel to kill a
     * 512 MB container; a baseline single-scan JPEG of the same size needs only 18 MB because libjpeg decodes it row by
     * row. The admin page already downscales images to at most 2400px in the browser (at most ~46 MB here), so this
     * ceiling only blocks very large progressive images sent straight to the API.
     */
    private static final long MAX_JPEG_COEFFICIENT_BYTES = 64L * 1024 * 1024;

    /**
     * RGB profiles of displays and working spaces (sRGB, Display P3, Adobe RGB) are a few hundred bytes to a few KB.
     * An iCCP that inflates beyond 1 MiB is skipped (the image is treated as sRGB, as before), without inflating further.
     */
    private static final int MAX_ICC_PROFILE_BYTES = 1024 * 1024;

    /** The ResampleOp types it can handle directly, without first copying to another type. */
    private static final Set<Integer> RESAMPLE_READY = Set.of(BufferedImage.TYPE_INT_RGB, BufferedImage.TYPE_3BYTE_BGR);

    /** "yyyy:MM:dd hh:mm:ss" per EXIF; some software writes hyphens instead of colons in the date part. */
    private static final Pattern EXIF_DATE = Pattern.compile("^(\\d{4})[:-](\\d{2})[:-](\\d{2})");

    private final MediaProperties properties;
    private final long maxStoredBytes;

    public ImageProcessor(MediaProperties properties) {
        this.properties = Objects.requireNonNull(properties, "properties");
        this.maxStoredBytes = properties.maxStoredSize().toBytes();
    }

    /**
     * @throws ApiException 415 {@code MEDIA_UNSUPPORTED_TYPE} when the magic bytes are not JPEG/PNG/WebP;
     *                      422 {@code MEDIA_UNREADABLE} when the header or the image data is damaged;
     *                      422 {@code MEDIA_DIMENSIONS_TOO_LARGE} when width x height exceeds {@code maxPixels};
     *                      413 {@code MEDIA_TOO_LARGE} when even shrinking to 800px does not fit {@code maxStoredSize}
     */
    public ProcessedImage process(byte[] input) {
        ImageFormat format = ImageFormat.sniff(input)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.MEDIA_UNSUPPORTED_TYPE,
                        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                        "Only JPEG, PNG and WebP images are accepted"));
        ExifSummary exif = ExifSummary.read(input, format);
        // The TwelveMonkeys JPEG and WebP readers convert an embedded profile to sRGB themselves; the JDK PNG reader
        // ignores iCCP.
        ICC_Profile pngProfile = format == ImageFormat.PNG ? pngColourProfile(input) : null;
        Prepared prepared = prepare(input, format, exif.orientation(), pngProfile);
        Encoded encoded = encode(prepared, format);
        return new ProcessedImage(
                encoded.bytes(),
                encoded.contentType(),
                encoded.image().getWidth(),
                encoded.image().getHeight(),
                sha256(encoded.bytes()),
                dominantColor(encoded.image()),
                exif.takenOn());
    }

    /**
     * The size the header of an image declares, without decoding a pixel (and so without any permit). Empty when the format is
     * not accepted or the header cannot be read. The size is the one before the orientation and the downscaling of
     * {@link #process}, so it is only fit for a preview of the original.
     */
    public static Optional<int[]> headerSize(byte[] input) {
        Optional<ImageFormat> format = ImageFormat.sniff(input);
        if (format.isEmpty()) {
            return Optional.empty();
        }
        ImageReader reader = reader(format.get());
        try (ImageInputStream stream = new ByteArrayImageInputStream(input)) {
            reader.setInput(stream, true, true);
            int width = reader.getWidth(0);
            int height = reader.getHeight(0);
            return width > 0 && height > 0 ? Optional.of(new int[] {width, height}) : Optional.empty();
        } catch (IOException | RuntimeException e) {
            return Optional.empty();
        } finally {
            reader.dispose();
        }
    }

    // --- Decode -----------------------------------------------------------------------------------

    /** A decoded image, correctly oriented, in sRGB, long edge <= maxEdge, type TYPE_INT_RGB or TYPE_INT_ARGB. */
    private record Prepared(BufferedImage image, boolean translucent) {}

    private Prepared prepare(byte[] input, ImageFormat format, int orientation, ICC_Profile embeddedProfile) {
        BufferedImage image = decode(input, format);
        // An RGB profile only makes sense for a color image (palette images included); a grayscale PNG goes with a gray
        // profile, which is ignored.
        boolean colour = image.getColorModel().getColorSpace().getType() == ColorSpace.TYPE_RGB;
        image = toSrgb(image);
        boolean translucent = hasTranslucentPixel(image);
        if (Math.max(image.getWidth(), image.getHeight()) > properties.maxEdge()) {
            // Reassign the same variable: the full-size decoded image (up to ~90 MB) is unreferenced as soon as it is
            // downscaled.
            image = resample(image, properties.maxEdge(), translucent);
        }
        if (embeddedProfile != null && colour) {
            // After the downscale: color conversion runs on at most maxEdge pixels per side, not on the fully decoded
            // image.
            image = fromEmbeddedProfile(image, embeddedProfile);
        }
        return new Prepared(redraw(image, orientation, translucent), translucent);
    }

    private BufferedImage decode(byte[] input, ImageFormat format) {
        // The reader for the SNIFFED format, not ImageIO.getImageReaders(stream): if ImageIO guessed, a file carrying
        // PNG magic bytes could still be claimed by another reader.
        ImageReader reader = reader(format);
        try (ImageInputStream stream = new ByteArrayImageInputStream(input)) {
            reader.setInput(stream, true, true);
            int width;
            int height;
            try {
                width = reader.getWidth(0);
                height = reader.getHeight(0);
            } catch (IOException | RuntimeException e) {
                throw unreadable(format, e);
            }
            if (width <= 0 || height <= 0) {
                throw unreadable(format, null);
            }
            if (width > MAX_SIDE || height > MAX_SIDE || (long) width * height > properties.maxPixels()) {
                throw new ApiException(
                        ErrorCode.MEDIA_DIMENSIONS_TOO_LARGE,
                        HttpStatus.UNPROCESSABLE_CONTENT,
                        "The image is " + width + "x" + height + " pixels; at most " + properties.maxPixels()
                                + " pixels, and " + MAX_SIDE + " pixels per side, are accepted");
            }
            if (format == ImageFormat.JPEG) {
                requireBoundedJpegDecode(input, width, height);
            }
            // Subsampled decode (s = floor(long edge / maxEdge)): an 8160x6120 image becomes 2720x2040, ~29 MB of heap
            // instead
            // of ~152 MB. Floor, not round-up, so the decoded image is never smaller than maxEdge.
            int step = Math.max(1, Math.max(width, height) / properties.maxEdge());
            ImageReadParam param = reader.getDefaultReadParam();
            param.setSourceSubsampling(step, step, 0, 0);
            try {
                return reader.read(0, param);
            } catch (IOException | RuntimeException e) {
                // RuntimeException counts too: the reader throws IllegalArgument/IndexOutOfBounds... on damaged
                // data, and that is still "this file cannot be read", not a server error.
                throw unreadable(format, e);
            }
        } catch (IOException e) {
            throw unreadable(format, e);
        } finally {
            reader.dispose();
        }
    }

    private static ImageReader reader(ImageFormat format) {
        Iterator<ImageReader> readers = ImageIO.getImageReadersByFormatName(format.readerFormatName());
        if (!readers.hasNext()) {
            throw new IllegalStateException("No ImageIO reader for " + format);
        }
        return readers.next();
    }

    private static ApiException unreadable(ImageFormat format, Exception cause) {
        // ApiException carries no cause; log the library's real reason here so we can tell why a specific image was
        // rejected, but do not put it in the response.
        log.info(
                "Rejected an unreadable {} upload: {}",
                format,
                cause == null ? "non-positive dimensions" : cause.toString());
        return new ApiException(
                ErrorCode.MEDIA_UNREADABLE,
                HttpStatus.UNPROCESSABLE_CONTENT,
                "The image could not be read; the file may be damaged or truncated");
    }

    // --- JPEG structure ----------------------------------------------------------------------------

    /**
     * Before decoding, blocks JPEGs for which the decoder must keep the whole image in memory, something the width x
     * height limit does not measure:
     * - lossless (SOF3, 7, 11, 15): TwelveMonkeys decodes SOF3 with Java code over the whole image, with no subsampling; a
     *   file of ~700 bytes declaring 7000x7000 was measured to fill ~200 MB of heap and then throw an OutOfMemoryError.
     *   No camera or web image is a lossless JPEG (it belongs to medical imaging, DNG), so it gets 415 like any other
     *   unaccepted format;
     * - progressive or multi-scan: a native coefficient buffer, capped by {@link #MAX_JPEG_COEFFICIENT_BYTES}.
     * If the SOFn and then SOS structure cannot be read, the file cannot be decoded: 422 right away, without letting the
     * decoder try.
     */
    private static void requireBoundedJpegDecode(byte[] input, int width, int height) {
        JpegFrame frame = JpegFrame.read(input);
        if (frame == null) {
            log.info("Rejected an unreadable JPEG upload: no SOFn and SOS markers in a readable order");
            throw new ApiException(
                    ErrorCode.MEDIA_UNREADABLE,
                    HttpStatus.UNPROCESSABLE_CONTENT,
                    "The image could not be read; the file may be damaged or truncated");
        }
        if (frame.lossless()) {
            throw new ApiException(
                    ErrorCode.MEDIA_UNSUPPORTED_TYPE,
                    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                    "Lossless JPEG is not accepted; save the image as a regular JPEG, PNG or WebP");
        }
        long coefficientBytes = frame.coefficientBytes();
        if (frame.buffersWholeImage() && coefficientBytes > MAX_JPEG_COEFFICIENT_BYTES) {
            throw new ApiException(
                    ErrorCode.MEDIA_DIMENSIONS_TOO_LARGE,
                    HttpStatus.UNPROCESSABLE_CONTENT,
                    "The image is " + width + "x" + height + " pixels in a progressive or multi-scan JPEG, which needs "
                            + (coefficientBytes >> 20) + " MB to decode; at most " + (MAX_JPEG_COEFFICIENT_BYTES >> 20)
                            + " MB is accepted. Save it as a baseline JPEG or downscale it first");
        }
    }

    /**
     * The frame of a JPEG, read from the first SOFn and SOS markers: enough to know whether the decoder must keep the
     * whole image. Read the way libjpeg reads (skipping junk bytes and 0xFF padding bytes between markers), over a
     * byte array with bounds checks.
     *
     * @param sampling            sampling factors {horizontal, vertical} of each color component
     * @param firstScanComponents number of components in the first scan; fewer than the frame's components means a multi-scan image
     */
    record JpegFrame(int sofMarker, int width, int height, int[][] sampling, int firstScanComponents) {

        boolean lossless() {
            return sofMarker == 0xC3 || sofMarker == 0xC7 || sofMarker == 0xCB || sofMarker == 0xCF;
        }

        /** libjpeg keeps the whole-image coefficients when the image is progressive, or when the first scan does not contain every component. */
        boolean buffersWholeImage() {
            boolean progressive = sofMarker == 0xC2 || sofMarker == 0xC6 || sofMarker == 0xCA || sofMarker == 0xCE;
            return progressive || firstScanComponents < sampling.length;
        }

        /**
         * Exactly how libjpeg allocates the coefficient arrays (jdcoefct.c): each component is width_in_blocks x
         * height_in_blocks, rounded up to a multiple of the sampling factor, each block being 64 coefficients of 2 bytes.
         */
        long coefficientBytes() {
            int maxH = 1;
            int maxV = 1;
            for (int[] hv : sampling) {
                maxH = Math.max(maxH, hv[0]);
                maxV = Math.max(maxV, hv[1]);
            }
            long blocks = 0;
            for (int[] hv : sampling) {
                long widthInBlocks = Math.ceilDiv((long) width * hv[0], 8L * maxH);
                long heightInBlocks = Math.ceilDiv((long) height * hv[1], 8L * maxV);
                blocks += Math.ceilDiv(widthInBlocks, hv[0]) * hv[0] * Math.ceilDiv(heightInBlocks, hv[1]) * hv[1];
            }
            return blocks * 64 * 2;
        }

        static JpegFrame read(byte[] data) {
            int sofMarker = -1;
            int width = 0;
            int height = 0;
            int[][] sampling = null;
            int i = 2; // after SOI
            while (i + 1 < data.length) {
                if ((data[i] & 0xff) != 0xFF) {
                    i++; // junk byte before a marker: libjpeg skips it and moves on
                    continue;
                }
                int marker = data[i + 1] & 0xff;
                if (marker == 0xFF) {
                    i++; // padding byte
                    continue;
                }
                if (marker == 0x00 || marker == 0x01 || (marker >= 0xD0 && marker <= 0xD9)) {
                    i += 2; // a marker with no length part (TEM, RSTn, SOI, EOI)
                    continue;
                }
                if (i + 4 > data.length) {
                    return null;
                }
                int length = ((data[i + 2] & 0xff) << 8) | (data[i + 3] & 0xff);
                int body = i + 4;
                if (length < 2 || i + 2 + length > data.length) {
                    return null;
                }
                if (marker == 0xDA) {
                    return sampling == null || length < 3
                            ? null
                            : new JpegFrame(sofMarker, width, height, sampling, data[body] & 0xff);
                }
                if (isStartOfFrame(marker) && sampling == null) {
                    int components = length >= 8 ? data[body + 5] & 0xff : 0;
                    if (components < 1 || length < 8 + 3 * components) {
                        return null;
                    }
                    height = ((data[body + 1] & 0xff) << 8) | (data[body + 2] & 0xff);
                    width = ((data[body + 3] & 0xff) << 8) | (data[body + 4] & 0xff);
                    sampling = new int[components][];
                    for (int c = 0; c < components; c++) {
                        int factors = data[body + 6 + 3 * c + 1] & 0xff;
                        int h = factors >> 4;
                        int v = factors & 0x0f;
                        if (h < 1 || h > 4 || v < 1 || v > 4) {
                            return null;
                        }
                        sampling[c] = new int[] {h, v};
                    }
                    sofMarker = marker;
                }
                i += 2 + length;
            }
            return null;
        }

        /** C0-CF except C4 (DHT), C8 (JPG, reserved) and CC (DAC). */
        private static boolean isStartOfFrame(int marker) {
            return marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC;
        }
    }

    // --- Color -------------------------------------------------------------------------------------

    /**
     * Converts the image to sRGB. The TwelveMonkeys JPEG and WebP readers already convert an embedded ICC profile (P3,
     * CMYK...) to sRGB themselves; a PNG with iCCP gets here through {@link #fromEmbeddedProfile}; apart from that the
     * ColorConvertOp branch is a safety net for any reader that returns another color space.
     *
     * Grayscale images take their own path: Java2D treats CS_GRAY as LINEAR gray, so ColorConvertOp (and getRGB) turn
     * the value 100 into ~168 and wash the whole image out. The gray values in the file are in fact already display
     * values, so they are copied straight to R=G=B.
     */
    static BufferedImage toSrgb(BufferedImage image) {
        ColorSpace space = image.getColorModel().getColorSpace();
        if (space.isCS_sRGB()) {
            return image;
        }
        if (space.getType() == ColorSpace.TYPE_GRAY && hasIntegerComponents(image.getColorModel())) {
            return greyToRgb(image);
        }
        BufferedImage target = new BufferedImage(
                image.getWidth(),
                image.getHeight(),
                image.getColorModel().hasAlpha() ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        new ColorConvertOp(null).filter(image, target);
        return target;
    }

    /** Every component is an integer of 1-16 bits, so {@code (1 << bits) - 1} is its maximum value. */
    private static boolean hasIntegerComponents(ColorModel model) {
        for (int bits : model.getComponentSize()) {
            if (bits < 1 || bits > 16) {
                return false;
            }
        }
        return true;
    }

    private static BufferedImage greyToRgb(BufferedImage grey) {
        ColorModel model = grey.getColorModel();
        boolean alpha = model.hasAlpha();
        boolean premultiplied = model.isAlphaPremultiplied();
        int width = grey.getWidth();
        int height = grey.getHeight();
        int greyMax = (1 << model.getComponentSize(0)) - 1;
        int alphaMax = alpha ? (1 << model.getComponentSize(1)) - 1 : 1;
        BufferedImage target =
                new BufferedImage(width, height, alpha ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        int[] out = ((DataBufferInt) target.getRaster().getDataBuffer()).getData();
        Raster raster = grey.getRaster();
        int[] greys = new int[width];
        int[] alphas = new int[width];
        for (int y = 0; y < height; y++) {
            raster.getSamples(0, y, width, 1, 0, greys);
            if (alpha) {
                raster.getSamples(0, y, width, 1, 1, alphas);
            }
            for (int x = 0; x < width; x++) {
                int a = alpha ? to8Bit(alphas[x], alphaMax) : 255;
                int g = premultiplied
                        ? (a == 0 ? 0 : Math.min(255, to8Bit(greys[x], greyMax) * 255 / a))
                        : to8Bit(greys[x], greyMax);
                out[y * width + x] = (a << 24) | (g << 16) | (g << 8) | g;
            }
        }
        return target;
    }

    private static int to8Bit(int value, int max) {
        return max == 255 ? value : (int) ((value * 255L + max / 2) / max);
    }

    /**
     * Converts an image whose pixel values actually live in the space of {@code profile} to sRGB. The JDK PNG reader
     * ignores the iCCP chunk and labels every image it reads as sRGB, so iPhone/Mac screenshots (Display P3) go through
     * the pipeline with P3 values under an sRGB label: dropping the profile when re-encoding turns red #ff0000 into the
     * washed-out #ea3322.
     *
     * Copies the raw values unchanged into a byte raster (source and target carry the same sRGB label, so Java2D changes
     * nothing), attaches the right profile label, then lets ColorConvertOp convert. The alpha channel is split off and
     * merged back afterwards: ColorConvertOp only takes the LCMS fast path when the target has no alpha. When the profile
     * is not usable by LCMS, the image is left as it was, as before.
     */
    static BufferedImage fromEmbeddedProfile(BufferedImage image, ICC_Profile profile) {
        int width = image.getWidth();
        int height = image.getHeight();
        boolean alpha = image.getColorModel().hasAlpha();
        BufferedImage raw = copy(image, alpha ? BufferedImage.TYPE_4BYTE_ABGR : BufferedImage.TYPE_3BYTE_BGR);
        WritableRaster colours = Raster.createInterleavedRaster(DataBuffer.TYPE_BYTE, width, height, 3, null);
        colours.setRect(raw.getRaster().createChild(0, 0, width, height, 0, 0, new int[] {0, 1, 2}));
        BufferedImage converted = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        try {
            ComponentColorModel tagged = new ComponentColorModel(
                    new ICC_ColorSpace(profile), false, false, Transparency.OPAQUE, DataBuffer.TYPE_BYTE);
            new ColorConvertOp(null).filter(new BufferedImage(tagged, colours, false, null), converted);
        } catch (RuntimeException e) {
            log.info("Ignored an unusable embedded colour profile: {}", e.toString());
            return image;
        }
        if (!alpha) {
            return converted;
        }
        BufferedImage target = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        int[] out = ((DataBufferInt) target.getRaster().getDataBuffer()).getData();
        int[] rgb = ((DataBufferInt) converted.getRaster().getDataBuffer()).getData();
        int[] alphas = new int[width];
        Raster rawRaster = raw.getRaster();
        for (int y = 0; y < height; y++) {
            rawRaster.getSamples(0, y, width, 1, 3, alphas);
            for (int x = 0; x < width; x++) {
                out[y * width + x] = (alphas[x] << 24) | (rgb[y * width + x] & 0xffffff);
            }
        }
        return target;
    }

    /**
     * Whether any pixel has alpha below the maximum opacity. A present alpha channel is not enough: PNGs exported from
     * many tools always have an alpha channel even when every pixel is opaque, and such an image should be treated as opaque.
     */
    static boolean hasTranslucentPixel(BufferedImage image) {
        ColorModel model = image.getColorModel();
        if (!model.hasAlpha()) {
            return false;
        }
        int width = image.getWidth();
        int height = image.getHeight();
        int[] row = new int[width];
        if (model instanceof IndexColorModel palette) {
            // Palette image: the raster holds indexes. A transparent entry that sits in the palette but is used by no
            // pixel
            // leaves the image opaque.
            byte[] alphas = new byte[palette.getMapSize()];
            palette.getAlphas(alphas);
            Raster raster = image.getRaster();
            for (int y = 0; y < height; y++) {
                raster.getSamples(0, y, width, 1, 0, row);
                for (int index : row) {
                    if (index < alphas.length && (alphas[index] & 0xff) != 0xff) {
                        return true;
                    }
                }
            }
            return false;
        }
        WritableRaster alpha = image.getAlphaRaster();
        int alphaBits = model.getComponentSize(model.getNumComponents() - 1);
        if (alpha == null || alphaBits < 1 || alphaBits > 16) {
            // Unusual color model (the alpha channel cannot be split off, or alpha is floating point): ask pixel by
            // pixel, slow but correct.
            for (int y = 0; y < height; y++) {
                image.getRGB(0, y, width, 1, row, 0, width);
                for (int argb : row) {
                    if ((argb >>> 24) != 0xff) {
                        return true;
                    }
                }
            }
            return false;
        }
        int opaque = (1 << alphaBits) - 1;
        for (int y = 0; y < height; y++) {
            alpha.getSamples(0, y, width, 1, 0, row);
            for (int value : row) {
                if (value < opaque) {
                    return true;
                }
            }
        }
        return false;
    }

    // --- Size and orientation -----------------------------------------------------------------------

    /**
     * Lanczos down to a long edge of {@code longEdge}. A translucent image is filtered premultiplied: filtering ARGB
     * directly lets the color of fully transparent pixels (usually black) bleed into the edges, giving a dark fringe around a logo.
     */
    private static BufferedImage resample(BufferedImage source, int longEdge, boolean translucent) {
        double scale = (double) longEdge / Math.max(source.getWidth(), source.getHeight());
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        BufferedImage input = translucent
                ? copy(source, BufferedImage.TYPE_INT_ARGB_PRE)
                : RESAMPLE_READY.contains(source.getType()) ? source : copy(source, BufferedImage.TYPE_INT_RGB);
        return new ResampleOp(width, height, ResampleOp.FILTER_LANCZOS).filter(input, null);
    }

    private static BufferedImage copy(BufferedImage source, int type) {
        BufferedImage target = new BufferedImage(source.getWidth(), source.getHeight(), type);
        Graphics2D g = target.createGraphics();
        try {
            g.setComposite(AlphaComposite.Src);
            g.drawImage(source, 0, 0, null);
        } finally {
            g.dispose();
        }
        return target;
    }

    /**
     * Redraws into a new image of type TYPE_INT_RGB (opaque) or TYPE_INT_ARGB (translucent, not premultiplied), applying
     * the EXIF orientation at the same time. Every image leaving here is one of those two types, so the encoder and the
     * dominant-color computation only need to know two types. A JPEG is always drawn from TYPE_INT_RGB: writing an ARGB
     * raster as JPEG produces the classic pink/wrong-color image (the reader misreads it as CMYK).
     */
    private static BufferedImage redraw(BufferedImage source, int orientation, boolean translucent) {
        int width = source.getWidth();
        int height = source.getHeight();
        boolean swap = orientation >= 5;
        BufferedImage target = new BufferedImage(
                swap ? height : width,
                swap ? width : height,
                translucent ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        Graphics2D g = target.createGraphics();
        try {
            g.setComposite(AlphaComposite.Src);
            // Only flips/rotations by multiples of 90 degrees: nearest-neighbor sampling gives exactly each pixel, with
            // no interpolation.
            g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_NEAREST_NEIGHBOR);
            g.drawImage(source, orientationTransform(orientation, width, height), null);
        } finally {
            g.dispose();
        }
        return target;
    }

    /**
     * The transform that takes the STORED image (w x h) to the VIEWED image, per the TIFF/EXIF Orientation table. For
     * example 6 = "row 0 is the right edge of the viewed image": rotate 90 degrees clockwise. 5-8 swap width and height.
     * Parameters follow the order of AffineTransform(m00, m10, m01, m11, m02, m12): x' = m00*x + m01*y + m02,
     * y' = m10*x + m11*y + m12.
     */
    private static AffineTransform orientationTransform(int orientation, int w, int h) {
        return switch (orientation) {
            case 2 -> new AffineTransform(-1, 0, 0, 1, w, 0); // flip horizontally
            case 3 -> new AffineTransform(-1, 0, 0, -1, w, h); // rotate 180 degrees
            case 4 -> new AffineTransform(1, 0, 0, -1, 0, h); // flip vertically
            case 5 -> new AffineTransform(0, 1, 1, 0, 0, 0); // transpose across the main diagonal
            case 6 -> new AffineTransform(0, 1, -1, 0, h, 0); // rotate 90 degrees clockwise
            case 7 -> new AffineTransform(0, -1, -1, 0, h, w); // transpose across the anti-diagonal
            case 8 -> new AffineTransform(0, -1, 1, 0, 0, w); // rotate 90 degrees counterclockwise
            default -> new AffineTransform();
        };
    }

    // --- Encoding ----------------------------------------------------------------------------------

    private enum OutputFormat {
        JPEG("jpeg", "image/jpeg"),
        PNG("png", "image/png");

        final String writerFormatName;
        final String contentType;

        OutputFormat(String writerFormatName, String contentType) {
            this.writerFormatName = writerFormatName;
            this.contentType = contentType;
        }
    }

    private record Encoded(byte[] bytes, OutputFormat format, BufferedImage image) {
        String contentType() {
            return format.contentType;
        }
    }

    /**
     * Picks the output format, then encodes within the {@code maxStoredSize} ceiling:
     * - has translucent pixels -> PNG (JPEG has no alpha);
     * - opaque PNG -> stay PNG if it fits the ceiling (screenshots, diagrams: JPEG blurs text); if not -> JPEG;
     * - everything else (JPEG photos, opaque WebP) -> JPEG.
     */
    private Encoded encode(Prepared prepared, ImageFormat source) {
        if (prepared.translucent()) {
            return encodeWithinLimit(prepared.image(), OutputFormat.PNG, true);
        }
        if (source == ImageFormat.PNG) {
            byte[] png = write(prepared.image(), OutputFormat.PNG);
            if (png.length <= maxStoredBytes) {
                return new Encoded(png, OutputFormat.PNG, prepared.image());
            }
        }
        return encodeWithinLimit(prepared.image(), OutputFormat.JPEG, false);
    }

    /**
     * Encodes; if it exceeds the ceiling, shrinks the long edge x0.8 (always from the full image, so blur does not
     * accumulate) and tries again; if it still does not fit at 800px, 413. Applies to JPEG too, not only translucent PNG:
     * a noisy 2400px JPEG at q0.85 was measured at ~4.36 MB, over 4 MiB, and letting it reach the DB would make the
     * byte_size CHECK return a confusing 409.
     */
    private Encoded encodeWithinLimit(BufferedImage full, OutputFormat format, boolean translucent) {
        BufferedImage current = full;
        while (true) {
            byte[] bytes = write(current, format);
            if (bytes.length <= maxStoredBytes) {
                return new Encoded(bytes, format, current);
            }
            int longEdge = Math.max(current.getWidth(), current.getHeight());
            if (longEdge <= MIN_EDGE) {
                throw new ApiException(
                        ErrorCode.MEDIA_TOO_LARGE,
                        HttpStatus.CONTENT_TOO_LARGE,
                        "The image does not fit in " + maxStoredBytes + " bytes even when downscaled to " + MIN_EDGE
                                + "px");
            }
            int next = Math.max(MIN_EDGE, (int) (longEdge * SHRINK_FACTOR));
            current = redraw(resample(full, next, translucent), 1, translucent);
        }
    }

    private byte[] write(BufferedImage image, OutputFormat format) {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName(format.writerFormatName);
        if (!writers.hasNext()) {
            throw new IllegalStateException("No ImageIO writer for " + format);
        }
        ImageWriter writer = writers.next();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        // An explicit MemoryCacheImageOutputStream instead of ImageIO.createImageOutputStream: the result does not
        // depend on the global ImageIO.setUseCache flag, and there is never a temp file.
        try (ImageOutputStream out = new MemoryCacheImageOutputStream(bytes)) {
            writer.setOutput(out);
            ImageWriteParam param = writer.getDefaultWriteParam();
            if (format == OutputFormat.JPEG) {
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(properties.jpegQuality());
                if (param instanceof JPEGImageWriteParam jpeg) {
                    // Optimized Huffman tables: same quality, a file a few percent smaller.
                    jpeg.setOptimizeHuffmanTables(true);
                }
            }
            // Null metadata: the encoder writes only what is required (JFIF APP0; or IHDR/IDAT/IEND). Nothing from the
            // original file (EXIF, GPS, ICC, XMP, comments) can pass through this step.
            writer.write(null, new IIOImage(image, null, null), param);
        } catch (IOException e) {
            throw new UncheckedIOException("Encoding an image into memory failed", e);
        } finally {
            writer.dispose();
        }
        return bytes.toByteArray();
    }

    // --- Secondary results ------------------------------------------------------------------------

    /**
     * Average color, each pixel weighted by its opacity: the transparent part has no visible color, so it must not pull the
     * color toward black. Computed directly on the pixels rather than with a 1x1 ResampleOp: measured, a ResampleOp
     * straight down to 1x1 does not give the average (a half-red half-blue image comes out #fc0003).
     * Null when the image is fully transparent.
     */
    static String dominantColor(BufferedImage image) {
        int[] pixels = ((DataBufferInt) image.getRaster().getDataBuffer()).getData();
        boolean alpha = image.getColorModel().hasAlpha();
        long red = 0;
        long green = 0;
        long blue = 0;
        long weight = 0;
        for (int p : pixels) {
            int a = alpha ? p >>> 24 : 255;
            red += (long) ((p >> 16) & 0xff) * a;
            green += (long) ((p >> 8) & 0xff) * a;
            blue += (long) (p & 0xff) * a;
            weight += a;
        }
        if (weight == 0) {
            return null;
        }
        return String.format(
                Locale.ROOT,
                "#%02x%02x%02x",
                Math.round((double) red / weight),
                Math.round((double) green / weight),
                Math.round((double) blue / weight));
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("Every JDK provides SHA-256", e);
        }
    }

    // --- Embedded PNG color profile -----------------------------------------------------------------

    /**
     * The RGB profile in the iCCP chunk of a PNG, or null: no iCCP, a profile that is not RGB, or damaged data.
     * Same policy as EXIF: metadata is optional, and when damaged it counts as absent (the image is read as sRGB, like any
     * PNG that declares no profile); an image whose pixels still decode is not rejected.
     *
     * Reads only the iCCP chunk, from a byte array with bounds checks; the compressed part is inflated with a ceiling, so a
     * chunk that declares a profile of hundreds of MB cannot ask for that memory.
     */
    static ICC_Profile pngColourProfile(byte[] input) {
        try {
            for (PngChunk chunk :
                    new PngChunkReader().extract(new SequentialByteArrayReader(input), Set.of(PngChunkType.iCCP))) {
                return iccProfileOf(chunk.getBytes());
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    /** iCCP body: profile name (1-79 bytes), a 0 byte, compression method (0 = zlib), then the compressed profile. */
    private static ICC_Profile iccProfileOf(byte[] payload) throws IOException {
        int nul = 0;
        while (nul < payload.length && nul < 80 && payload[nul] != 0) {
            nul++;
        }
        if (nul == 0 || nul > 79 || nul + 2 >= payload.length || payload[nul] != 0 || payload[nul + 1] != 0) {
            return null;
        }
        byte[] data;
        try (InputStream in =
                new InflaterInputStream(new ByteArrayInputStream(payload, nul + 2, payload.length - nul - 2))) {
            data = in.readNBytes(MAX_ICC_PROFILE_BYTES + 1);
        }
        if (data.length > MAX_ICC_PROFILE_BYTES) {
            return null;
        }
        // The header is looked at before the native colour engine is: a profile that is not shaped like an RGB image
        // profile
        // is treated as absent (the image is read as sRGB) and never reaches LCMS.
        if (!IccProfileHeader.plausible(data)) {
            return null;
        }
        ICC_Profile profile = ICC_Profile.getInstance(data);
        return profile.getColorSpaceType() == ColorSpace.TYPE_RGB ? profile : null;
    }

    // --- EXIF --------------------------------------------------------------------------------------

    /**
     * The only two things the pipeline needs from the original metadata. Only the EXIF block is read (not XMP, ICC, IPTC,
     * and not the PNG zTXt that metadata-extractor would inflate without limit), and it is read from a byte array with
     * bounds checks, so a chunk that declares a length of 2 GB only breaks the metadata and cannot ask for 2 GB of memory.
     *
     * Metadata is optional: damaged EXIF counts as absent (orientation 1, no date taken), because if the pixels still
     * decode the image is still usable.
     */
    record ExifSummary(int orientation, LocalDate takenOn) {

        static final ExifSummary NONE = new ExifSummary(1, null);

        static ExifSummary read(byte[] input, ImageFormat format) {
            Metadata metadata = new Metadata();
            try {
                switch (format) {
                    case JPEG ->
                        JpegMetadataReader.process(
                                metadata, new ByteArrayInputStream(input), List.of(new ExifReader()));
                    case PNG -> {
                        for (PngChunk chunk : new PngChunkReader()
                                .extract(new SequentialByteArrayReader(input), Set.of(PngChunkType.eXIf))) {
                            extractExif(chunk.getBytes(), metadata);
                        }
                    }
                    case WEBP ->
                        new RiffReader().processRiff(new SequentialByteArrayReader(input), new ExifChunkOnly(metadata));
                }
            } catch (Exception e) {
                return NONE;
            }
            return new ExifSummary(orientation(metadata), takenOn(metadata));
        }

        private static void extractExif(byte[] payload, Metadata metadata) {
            // The spec says the EXIF chunk of PNG/WebP starts directly with the TIFF header, but some software copies
            // the
            // "Exif\0\0" prefix of the JPEG segment into it. Accept both.
            int offset = ExifReader.startsWithJpegExifPreamble(payload) ? ExifReader.JPEG_SEGMENT_PREAMBLE.length() : 0;
            new ExifReader().extract(new ByteArrayReader(payload, offset), metadata);
        }

        private static int orientation(Metadata metadata) {
            ExifIFD0Directory ifd0 = metadata.getFirstDirectoryOfType(ExifIFD0Directory.class);
            Integer value = ifd0 == null ? null : ifd0.getInteger(ExifIFD0Directory.TAG_ORIENTATION);
            return value != null && value >= 1 && value <= 8 ? value : 1;
        }

        /**
         * The date in DateTimeOriginal, taking the date part exactly as the camera wrote it (local time at capture). Does
         * not use getDateOriginal(): it builds a Date in an assumed time zone and can shift back/forward to another day.
         */
        private static LocalDate takenOn(Metadata metadata) {
            ExifSubIFDDirectory exif = metadata.getFirstDirectoryOfType(ExifSubIFDDirectory.class);
            String raw = exif == null ? null : exif.getString(ExifSubIFDDirectory.TAG_DATETIME_ORIGINAL);
            if (raw == null) {
                return null;
            }
            Matcher date = EXIF_DATE.matcher(raw.trim());
            if (!date.find()) {
                return null;
            }
            try {
                // A camera whose clock was never set writes "0000:00:00 00:00:00": month 0 does not exist, so it falls
                // into null.
                return LocalDate.of(
                        Integer.parseInt(date.group(1)),
                        Integer.parseInt(date.group(2)),
                        Integer.parseInt(date.group(3)));
            } catch (DateTimeException e) {
                return null;
            }
        }
    }

    /** Walks the WebP RIFF but accepts only the EXIF chunk. */
    private static final class ExifChunkOnly implements RiffHandler {

        private final Metadata metadata;

        ExifChunkOnly(Metadata metadata) {
            this.metadata = metadata;
        }

        @Override
        public boolean shouldAcceptRiffIdentifier(String identifier) {
            return "WEBP".equals(identifier);
        }

        @Override
        public boolean shouldAcceptChunk(String fourCC) {
            return "EXIF".equals(fourCC);
        }

        @Override
        public boolean shouldAcceptList(String fourCC) {
            return false;
        }

        @Override
        public void processChunk(String fourCC, byte[] payload) {
            ExifSummary.extractExif(payload, metadata);
        }

        @Override
        public void addError(String message) {
            // A RIFF structure error only means there is no usable metadata; the decode itself will say whether the
            // image is damaged.
        }
    }
}
