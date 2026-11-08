package com.blog.common.text;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;
import jakarta.validation.constraints.Pattern;
import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * The value is one line of text: no control character (a line break, a tab, NUL, a C1 control) and no Unicode line or
 * paragraph separator. For a name that an AUTHOR may type and that later reaches log lines, notifications and mail
 * subjects, so that it cannot carry a forged line (see {@link UserText#forLog}, which is the second barrier). Null
 * passes: pair it with {@code @NotBlank} where the value is required.
 */
@Documented
@Target({
    ElementType.METHOD,
    ElementType.FIELD,
    ElementType.ANNOTATION_TYPE,
    ElementType.CONSTRUCTOR,
    ElementType.PARAMETER,
    ElementType.TYPE_USE
})
@Retention(RetentionPolicy.RUNTIME)
@Constraint(validatedBy = {})
@Pattern(regexp = SingleLine.REGEXP, message = "must be a single line of text without control characters")
public @interface SingleLine {

    /** Every character that is not a control character (Cc) or a line (Zl) or paragraph (Zp) separator. */
    String REGEXP = "[^\\p{Cc}\\p{Zl}\\p{Zp}]*";

    String message() default "must be a single line of text without control characters";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};
}
