package com.blog.architecture;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import org.junit.jupiter.api.Test;

/**
 * The rule that keeps a secret out of a record's {@code toString}, proved on records of its own: a record that prints its
 * password is caught, and one that redacts itself, or has no secret-named String, is not. Without the negative case the
 * rule could be matching nothing and still pass over the whole code base.
 */
class SecretRecordRulesTest {

    record PrintsItsPassword(String email, String password) {}

    record PrintsItsRefreshToken(String refreshToken, long expiresIn) {}

    record RedactsItself(String email, String password) {
        @Override
        public String toString() {
            return "RedactsItself[redacted]";
        }
    }

    record HoldsNoSecret(String name, long tokensCount, Object password) {}

    record HoldsAnAddress(String tokenUri, String jwtTtl, String refreshCount) {}

    private static JavaClasses classes(Class<?>... types) {
        return new ClassFileImporter().importClasses(types);
    }

    @Test
    void a_record_that_prints_a_secret_named_string_is_a_violation() {
        assertThatThrownBy(() -> SecretRecordRules.RECORDS_WITH_A_SECRET_COMPONENT_REDACT_IT_IN_TO_STRING.check(
                        classes(PrintsItsPassword.class, PrintsItsRefreshToken.class)))
                .isInstanceOf(AssertionError.class)
                .hasMessageContaining("PrintsItsPassword")
                .hasMessageContaining("PrintsItsRefreshToken");
    }

    @Test
    void a_record_that_writes_its_own_toString_passes() {
        assertThatCode(() -> SecretRecordRules.RECORDS_WITH_A_SECRET_COMPONENT_REDACT_IT_IN_TO_STRING.check(
                        classes(RedactsItself.class)))
                .doesNotThrowAnyException();
    }

    @Test
    void a_record_without_a_secret_named_string_is_not_asked_to() {
        // The password here is an Object, not a String, and "tokensCount" is a number: the rule is about a String that
        // can
        // hold the secret itself.
        // Nothing matches the rule here, which ArchUnit would otherwise report as a rule that checked no class.
        assertThatCode(() -> SecretRecordRules.RECORDS_WITH_A_SECRET_COMPONENT_REDACT_IT_IN_TO_STRING
                        .allowEmptyShould(true)
                        .check(classes(HoldsNoSecret.class, HoldsAnAddress.class)))
                .doesNotThrowAnyException();
    }
}
