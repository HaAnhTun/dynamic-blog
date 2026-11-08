package com.blog.setup.service;

import com.blog.setup.config.SetupProperties;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The secret that proves the person running /setup controls the server: {@code SETUP_TOKEN} when it is set, otherwise a
 * code generated into {@code <SETUP_DATA_DIR>/setup-code}, readable only by whoever can read that file.
 *
 * The generated file is created only when absent and never overwritten (an operator's own code in that file stays the
 * code), written to a temporary file first and then linked or moved into place, so a crash never leaves a half-written
 * code behind. On POSIX file systems the directory it creates and the file are owner-only. The value never reaches a log,
 * an exception message or a response: only the path does.
 */
@Component
public class SetupCodeStore {

    private static final Logger log = LoggerFactory.getLogger(SetupCodeStore.class);

    private static final int CODE_BYTES = 32;
    /** An existing file larger than this is not a setup code: it is never read whole. */
    private static final long MAX_FILE_BYTES = 1024;

    private static final int MAX_CODE_LENGTH = 512;

    private final String token;
    private final Path file;
    private final SecureRandom random = new SecureRandom();

    public SetupCodeStore(SetupProperties properties) {
        // Checked when the bean is built: a SETUP_TOKEN that is too short stops the start.
        this.token = properties.configuredToken();
        this.file = properties.codeFile();
    }

    /** {@code SETUP_TOKEN} is the code; no file is used. */
    public boolean usesToken() {
        return token != null;
    }

    /** The absolute path of the generated code file (whether or not it exists). */
    public Path file() {
        return file;
    }

    /**
     * Creates the code file with a fresh random code when it does not exist yet; keeps an existing valid one.
     *
     * @throws IOException when the directory or the file cannot be written, or an existing file does not hold a valid
     *                     code (it is never overwritten: deleting it lets the next start generate a new one). The message
     *                     carries no code.
     */
    public void ensureFile() throws IOException {
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            requireValidFile();
            return;
        }
        Path directory = file.getParent();
        boolean posix = directory.getFileSystem().supportedFileAttributeViews().contains("posix");
        if (!Files.isDirectory(directory)) {
            if (posix) {
                Files.createDirectories(
                        directory, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            } else {
                Files.createDirectories(directory);
            }
        }
        FileAttribute<?>[] ownerOnly = posix
                ? new FileAttribute<?>[] {
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))
                }
                : new FileAttribute<?>[0];
        Path temporary = Files.createTempFile(directory, ".setup-code-", ".tmp", ownerOnly);
        try {
            byte[] content = (generateCode() + "\n").getBytes(StandardCharsets.US_ASCII);
            try (FileChannel channel =
                    FileChannel.open(temporary, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
                channel.write(ByteBuffer.wrap(content));
                channel.force(true);
            }
            publish(temporary);
        } finally {
            Files.deleteIfExists(temporary);
        }
        requireValidFile();
    }

    /**
     * Whether {@code candidate} is the setup code. Both sides are compared as SHA-256 digests with
     * {@link MessageDigest#isEqual}, so the time taken does not depend on how many leading characters are right. Leading
     * and trailing whitespace of the candidate is ignored (a pasted code often carries a newline). False when there is no
     * usable code at all.
     */
    public boolean matches(String candidate) {
        String expected = currentCode();
        byte[] given = sha256(candidate == null ? "" : candidate.strip());
        // Without a code, compare against a random value anyway: the same work, and nothing can match.
        byte[] wanted = sha256(expected != null ? expected : generateCode());
        return MessageDigest.isEqual(wanted, given) && expected != null;
    }

    /** Deletes the code file if it exists. Never throws: a failure is one WARN line with the path. */
    public void discard() {
        try {
            if (Files.deleteIfExists(file)) {
                log.info("setup code file {} deleted", file);
            }
        } catch (IOException | SecurityException e) {
            log.warn(
                    "setup code file {} could not be deleted ({}); setup is closed, so the code no longer works. "
                            + "Delete the file by hand.",
                    file,
                    e.getClass().getName());
        }
    }

    private void publish(Path temporary) throws IOException {
        try {
            // A hard link fails when the target exists: atomic "create only when absent", never an overwrite.
            Files.createLink(file, temporary);
        } catch (FileAlreadyExistsException ignored) {
            // Another instance on the same volume was faster: its code stays the code.
        } catch (UnsupportedOperationException | FileSystemException noHardLinks) {
            try {
                // No hard links on this file system: a move without REPLACE_EXISTING refuses an existing target.
                Files.move(temporary, file);
            } catch (FileAlreadyExistsException ignored) {
                // Same as above.
            }
        }
    }

    private void requireValidFile() throws IOException {
        if (readFile() == null) {
            throw new IOException("the existing file does not hold a valid setup code (at least "
                    + SetupProperties.MIN_TOKEN_LENGTH + " characters without spaces); delete it so the next start "
                    + "generates a new one");
        }
    }

    private String currentCode() {
        if (token != null) {
            return token;
        }
        try {
            return readFile();
        } catch (IOException | SecurityException e) {
            return null;
        }
    }

    /** The stripped content of the code file; null when it is missing, too large or not a well-formed code. */
    private String readFile() throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_FILE_BYTES) {
            return null;
        }
        String code = Files.readString(file, StandardCharsets.UTF_8).strip();
        return isWellFormed(code) ? code : null;
    }

    static boolean isWellFormed(String code) {
        if (code.length() < SetupProperties.MIN_TOKEN_LENGTH || code.length() > MAX_CODE_LENGTH) {
            return false;
        }
        return code.codePoints().noneMatch(cp -> Character.isWhitespace(cp) || Character.isISOControl(cp));
    }

    /** 32 random bytes, URL-safe Base64 without padding: 43 characters. */
    private String generateCode() {
        byte[] bytes = new byte[CODE_BYTES];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }
}
