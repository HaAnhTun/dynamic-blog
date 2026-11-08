package com.blog.auth.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import org.springframework.http.HttpStatus;

/**
 * The second step of this account is being checked by another request right now and the row lock did not come within two
 * seconds: 429, nothing was evaluated. It is NOT a {@link MfaRejection}: the transaction rolls back (a statement that timed
 * out has aborted the PostgreSQL transaction, which could not commit anything anyway).
 */
public final class MfaBusy extends ApiException {

    public MfaBusy() {
        super(
                ErrorCode.MFA_RATE_LIMITED,
                HttpStatus.TOO_MANY_REQUESTS,
                "Too many attempts; wait a moment and try again");
    }
}
