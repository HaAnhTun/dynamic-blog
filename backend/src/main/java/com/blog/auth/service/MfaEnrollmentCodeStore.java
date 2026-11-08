package com.blog.auth.service;

import com.blog.auth.mfa.MfaProperties;
import com.blog.setup.config.SetupProperties;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileSystemException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
 * The operator's proof for the forced enrollment of an administrator whose enrollment window is closed (an install that
 * existed before two-step verification, an operator reset, a promotion to ADMIN at runtime): {@code MFA_ENROLLMENT_TOKEN}
 * when it is set, otherwise a code generated into {@code <SETUP_DATA_DIR>/mfa-enrollment-code}. Whoever can read the server's
 * data directory is by definition the operator, so this proof cannot be phished with the password: the classic enrollment
 * hijack (a stranger who holds only the password enrolling an authenticator of their own first) needs it.
 *
 * It follows the mechanics of {@code SetupCodeStore} on purpose, which this class copies instead of sharing (the setup code
 * is a different secret with a different lifetime, and the two must be able to change independently): the generated file is
 * written to a temporary file first and then linked or moved into place, so a crash never leaves a half-written code; on
 * POSIX file systems the file is owner-only; the comparison is constant-time on SHA-256 digests. The value never reaches a
 * log, an exception message or a response: only the path does.
 *
 * Lifetime (ASVS 6.4.1; the deviation is recorded in docs/SECURITY.md): the generated code has no time-based expiry. It lives
 * until no administrator is pending and is shared by the pending administrators, but it is deleted on each successful
 * confirm and regenerated when another administrator is still pending ({@link #regenerate()}), so one administrator's
 * knowledge of the code does not carry to the next. An {@code MFA_ENROLLMENT_TOKEN} belongs to the operator and is not
 * rotated; the documentation says to remove it after the enrollment.
 */
@Component
public class MfaEnrollmentCodeStore {

    /** The file name inside {@code SETUP_DATA_DIR}. */
    public static final String FILE_NAME = "mfa-enrollment-code";

    private static final Logger log = LoggerFactory.getLogger(MfaEnrollmentCodeStore.class);
    private static final int CODE_BYTES = 32;
    private static final long MAX_FILE_BYTES = 1024;
    private static final int MAX_CODE_LENGTH = 512;

    private final String token;
    private final Path file;
    private final SecureRandom random;

    public MfaEnrollmentCodeStore(MfaProperties mfa, SetupProperties setup, SecureRandom random) {
        // Checked when the bean is built: a token that is too short stops the start.
        this.token = mfa.configuredEnrollmentToken();
        this.file = setup.dataFile(FILE_NAME);
        this.random = random;
    }

    /** {@code MFA_ENROLLMENT_TOKEN} is the code; no file is used. */
    public boolean usesToken() {
        return token != null;
    }

    /** The absolute path of the generated code file (whether or not it exists). */
    public Path file() {
        return file;
    }

    public boolean fileExists() {
        return Files.exists(file, LinkOption.NOFOLLOW_LINKS);
    }

    /**
     * Creates the code file with a fresh random code when it does not exist yet; keeps an existing valid one.
     *
     * @return true when this call created the file
     * @throws IOException when the directory or the file cannot be written, or an existing file does not hold a valid code
     *                     (it is never overwritten here). The message carries no code.
     */
    public boolean ensureFile() throws IOException {
        if (fileExists()) {
            requireValidFile();
            return false;
        }
        write(false);
        requireValidFile();
        return true;
    }

    /** Replaces the code with a new random one (the file mode only). */
    public void regenerate() throws IOException {
        write(true);
        requireValidFile();
    }

    /**
     * Whether {@code candidate} is the enrollment code. Both sides are compared as SHA-256 digests with
     * {@link MessageDigest#isEqual}, so the time taken does not depend on how many leading characters are right. Leading
     * and trailing whitespace of the candidate is ignored. False when there is no usable code at all.
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
                log.info("mfa enrollment code file {} deleted", file);
            }
        } catch (IOException | SecurityException e) {
            log.warn(
                    "mfa enrollment code file {} could not be deleted ({}); delete it by hand",
                    file,
                    e.getClass().getName());
        }
    }

    // --- Mechanics ----------------------------------------------------------------------------------------------

    private void write(boolean replace) throws IOException {
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
        Path temporary = Files.createTempFile(directory, ".mfa-enrollment-code-", ".tmp", ownerOnly);
        try {
            byte[] content = (generateCode() + "\n").getBytes(StandardCharsets.US_ASCII);
            try (FileChannel channel =
                    FileChannel.open(temporary, StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING)) {
                channel.write(ByteBuffer.wrap(content));
                channel.force(true);
            }
            publish(temporary, replace);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private void publish(Path temporary, boolean replace) throws IOException {
        if (replace) {
            try {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
            return;
        }
        try {
            // A hard link fails when the target exists: atomic "create only when absent", never an overwrite.
            Files.createLink(file, temporary);
        } catch (FileAlreadyExistsException ignored) {
            // Another instance on the same volume was faster: its code stays the code.
        } catch (UnsupportedOperationException | FileSystemException noHardLinks) {
            try {
                Files.move(temporary, file);
            } catch (FileAlreadyExistsException ignored) {
                // Same as above.
            }
        }
    }

    private void requireValidFile() throws IOException {
        if (readFile() == null) {
            throw new IOException("the existing file does not hold a valid enrollment code (at least "
                    + MfaProperties.MIN_TOKEN_LENGTH + " characters without spaces); delete it so the next start "
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
        if (code.length() < MfaProperties.MIN_TOKEN_LENGTH || code.length() > MAX_CODE_LENGTH) {
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
