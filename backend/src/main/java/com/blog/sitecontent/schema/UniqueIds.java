package com.blog.sitecontent.schema;

import static java.lang.annotation.ElementType.FIELD;
import static java.lang.annotation.ElementType.METHOD;
import static java.lang.annotation.ElementType.PARAMETER;

import jakarta.validation.Constraint;
import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;
import jakarta.validation.Payload;
import java.lang.annotation.Documented;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.util.Collection;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

/** The ids (or slugs) of the items of a list are all different. */
@Documented
@Constraint(validatedBy = UniqueIds.Validator.class)
@Target({FIELD, METHOD, PARAMETER})
@Retention(RetentionPolicy.RUNTIME)
public @interface UniqueIds {

    String message() default "must not contain two items with the same id";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};

    class Validator implements ConstraintValidator<UniqueIds, Collection<? extends Identified>> {

        @Override
        public boolean isValid(Collection<? extends Identified> items, ConstraintValidatorContext context) {
            if (items == null) {
                return true;
            }
            Set<String> seen = new HashSet<>();
            return items.stream()
                    .filter(Objects::nonNull)
                    .map(Identified::identity)
                    .allMatch(seen::add);
        }
    }
}
