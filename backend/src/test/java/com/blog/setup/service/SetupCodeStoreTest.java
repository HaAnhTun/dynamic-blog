package com.blog.setup.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.blog.setup.config.SetupProperties;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SetupCodeStoreTest {

    @TempDir
    Path temp;

    private SetupCodeStore store(Path dataDir) {
        return new SetupCodeStore(new SetupProperties(null, dataDir.toString(), true));
    }

    @Test
    void generates_a_random_url_safe_code_in_a_new_directory_and_accepts_only_that_code() throws IOException {
        Path dataDir = temp.resolve("data");
        SetupCodeStore store = store(dataDir);

        store.ensureFile();

        Path file = dataDir.resolve("setup-code");
        String code = Files.readString(file, StandardCharsets.UTF_8).strip();
        assertThat(code).matches("[A-Za-z0-9_-]{43}");
        assertThat(store.file()).isEqualTo(file.toAbsolutePath().normalize());
        assertThat(store.matches(code)).isTrue();
        assertThat(store.matches(" " + code + "\n")).isTrue();
        assertThat(store.matches(code.substring(1))).isFalse();
        assertThat(store.matches("")).isFalse();
        assertThat(store.matches(null)).isFalse();
        // No temporary file is left next to it.
        try (var files = Files.list(dataDir)) {
            assertThat(files.toList()).containsExactly(file);
        }

        Path other = temp.resolve("other");
        store(other).ensureFile();
        assertThat(Files.readString(other.resolve("setup-code"), StandardCharsets.UTF_8)
                        .strip())
                .isNotEqualTo(code);
    }

    @Test
    void the_file_and_the_directory_it_creates_are_owner_only_on_posix() throws IOException {
        assumeTrue(Files.getFileStore(temp).supportsFileAttributeView("posix"));
        Path dataDir = temp.resolve("posix");
        store(dataDir).ensureFile();

        assertThat(Files.getPosixFilePermissions(dataDir.resolve("setup-code")))
                .isEqualTo(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        assertThat(Files.getPosixFilePermissions(dataDir))
                .doesNotContain(
                        PosixFilePermission.GROUP_READ,
                        PosixFilePermission.GROUP_EXECUTE,
                        PosixFilePermission.OTHERS_READ,
                        PosixFilePermission.OTHERS_EXECUTE);
    }

    @Test
    void an_existing_code_file_is_never_overwritten() throws IOException {
        Path file = temp.resolve("setup-code");
        String operatorCode = "operator-chosen-code-0123456789";
        Files.writeString(file, operatorCode + "\n", StandardCharsets.UTF_8);
        SetupCodeStore store = store(temp);

        store.ensureFile();
        store.ensureFile();

        assertThat(Files.readString(file, StandardCharsets.UTF_8)).isEqualTo(operatorCode + "\n");
        assertThat(store.matches(operatorCode)).isTrue();
    }

    @Test
    void a_file_that_holds_no_valid_code_is_kept_and_nothing_matches() throws IOException {
        Path file = temp.resolve("setup-code");
        for (String content : new String[] {"", "short", "has spaces inside the setup code file"}) {
            Files.writeString(file, content, StandardCharsets.UTF_8);
            SetupCodeStore store = store(temp);

            assertThatThrownBy(store::ensureFile).isInstanceOf(IOException.class);
            assertThat(Files.readString(file, StandardCharsets.UTF_8)).isEqualTo(content);
            assertThat(store.matches(content)).isFalse();
            assertThat(store.matches("")).isFalse();
        }
    }

    @Test
    void an_unwritable_location_fails_closed() throws IOException {
        Path notADirectory = Files.writeString(temp.resolve("plain-file"), "x");
        SetupCodeStore store = store(notADirectory.resolve("data"));

        assertThatThrownBy(store::ensureFile).isInstanceOf(IOException.class);
        assertThat(store.matches("")).isFalse();
        assertThat(store.matches("anything-at-all-0123456789")).isFalse();
    }

    @Test
    void discard_deletes_the_file_and_is_quiet_when_it_is_absent() throws IOException {
        SetupCodeStore store = store(temp);
        store.ensureFile();
        String code = Files.readString(store.file(), StandardCharsets.UTF_8).strip();

        store.discard();
        store.discard();

        assertThat(store.file()).doesNotExist();
        assertThat(store.matches(code)).isFalse();
    }

    @Test
    void with_a_token_only_the_token_matches_even_when_a_code_file_exists() throws IOException {
        String token = "configured-setup-token-0123456789";
        Files.writeString(temp.resolve("setup-code"), "file-code-that-is-not-used-0123456789");
        SetupCodeStore store = new SetupCodeStore(new SetupProperties("  " + token + "  ", temp.toString(), true));

        assertThat(store.usesToken()).isTrue();
        assertThat(store.matches(token)).isTrue();
        assertThat(store.matches("file-code-that-is-not-used-0123456789")).isFalse();
    }
}
