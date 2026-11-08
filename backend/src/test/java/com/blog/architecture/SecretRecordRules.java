package com.blog.architecture;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;

import com.tngtech.archunit.base.DescribedPredicate;
import com.tngtech.archunit.core.domain.JavaClass;
import com.tngtech.archunit.core.domain.JavaField;
import com.tngtech.archunit.core.domain.JavaMethod;
import com.tngtech.archunit.core.domain.JavaModifier;
import com.tngtech.archunit.lang.ArchCondition;
import com.tngtech.archunit.lang.ArchRule;
import com.tngtech.archunit.lang.ConditionEvents;
import com.tngtech.archunit.lang.SimpleConditionEvent;
import java.util.regex.Pattern;

/**
 * A record prints every component in its generated {@code toString}, and Spring MVC (DEBUG and TRACE body logging), a
 * configuration error and an assertion message all print records. So a record that holds a secret in a {@code String}
 * must write its own {@code toString} that leaves the secret out ({@code docs/CONVENTIONS.md}, section 10).
 *
 * The test is on the name of the component, not on knowledge of each record: {@code password}, {@code token},
 * {@code secret}, {@code challenge}, {@code credential}, {@code jwt}, {@code masterKey}, {@code encryptionKey} (any case,
 * anywhere in the name). A new record with such a component fails the build until it redacts itself. The generated
 * {@code toString} of a record is {@code public final} in the bytecode; one a person wrote is not, and that is how the two
 * are told apart.
 */
final class SecretRecordRules {

    /** A name like a secret, unless it ends in what makes it an address or a number ({@code tokenUri}, {@code jwtTtl}). */
    private static final Pattern SECRET_NAME = Pattern.compile(
            "(?i)(?!.*(uri|url|ttl|count)$).*(password|passphrase|secret|token|challenge|credential|jwt|masterkey|encryptionkey).*");

    private static final DescribedPredicate<JavaClass> RECORD_WITH_A_SECRET_STRING =
            DescribedPredicate.describe("are records with a String component named like a secret", javaClass -> {
                return javaClass.isRecord()
                        && javaClass.getFields().stream().anyMatch(SecretRecordRules::isSecretString);
            });

    private static final ArchCondition<JavaClass> WRITE_THEIR_OWN_TO_STRING =
            new ArchCondition<>("declare their own toString, which leaves the secret out") {
                @Override
                public void check(JavaClass javaClass, ConditionEvents events) {
                    boolean own = javaClass.getMethods().stream().anyMatch(SecretRecordRules::isWrittenToString);
                    if (!own) {
                        events.add(SimpleConditionEvent.violated(
                                javaClass,
                                javaClass.getName() + " has a String component named like a secret and prints it in "
                                        + "the toString that Java generates; write a toString that leaves it out"));
                    }
                }
            };

    static final ArchRule RECORDS_WITH_A_SECRET_COMPONENT_REDACT_IT_IN_TO_STRING =
            classes().that(RECORD_WITH_A_SECRET_STRING).should(WRITE_THEIR_OWN_TO_STRING);

    private SecretRecordRules() {}

    private static boolean isSecretString(JavaField field) {
        return !field.getModifiers().contains(JavaModifier.STATIC)
                && field.getRawType().getName().equals("java.lang.String")
                && SECRET_NAME.matcher(field.getName()).matches();
    }

    /** {@code toString()} that is not the {@code public final} one the compiler generates for a record. */
    private static boolean isWrittenToString(JavaMethod method) {
        return method.getName().equals("toString")
                && method.getRawParameterTypes().isEmpty()
                && !method.getModifiers().contains(JavaModifier.FINAL);
    }
}
