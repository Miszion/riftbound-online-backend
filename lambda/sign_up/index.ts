import * as AWS from 'aws-sdk';

const cognito = new AWS.CognitoIdentityServiceProvider();

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';

interface SignUpRequest {
  email: string;
  password: string;
  username: string;
}

interface SignUpResponse {
  message: string;
  userId: string;
  userConfirmed: boolean;
}

interface ApiResponse<T> {
  statusCode: number;
  body: string;
  headers: {
    'Content-Type': string;
    'Access-Control-Allow-Origin': string;
  };
}

export const handler = async (event: any): Promise<ApiResponse<any>> => {
  console.log('Sign-up request:', event);

  try {
    const body: SignUpRequest = JSON.parse(event.body);
    const { email, password, username } = body;

    if (!email || !password || !username) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing email, password, or username',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    }

    // Sign up user
    const signUpParams: AWS.CognitoIdentityServiceProvider.SignUpRequest = {
      ClientId: CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        {
          Name: 'email',
          Value: email,
        },
        {
          Name: 'email_verified',
          Value: 'false',
        },
        {
          Name: 'preferred_username',
          Value: username,
        },
      ],
    };

    const signUpResponse = await cognito.signUp(signUpParams).promise();

    // Auto-confirm user for development (remove in production)
    const confirmParams: AWS.CognitoIdentityServiceProvider.AdminConfirmSignUpRequest = {
      UserPoolId: USER_POOL_ID,
      Username: email,
    };

    await cognito.adminConfirmSignUp(confirmParams).promise();

    const response: SignUpResponse = {
      message: 'User signed up successfully',
      userId: signUpResponse.UserSub || '',
      userConfirmed: false,
    };

    return {
      statusCode: 201,
      body: JSON.stringify(response),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    };
  } catch (error: any) {
    console.error('Sign-up error:', error);

    let statusCode = 500;
    let errorMessage = 'Internal server error';

    if (error.code === 'UsernameExistsException') {
      statusCode = 409;
      errorMessage = 'Email already registered';
    } else if (error.code === 'InvalidPasswordException') {
      statusCode = 400;
      errorMessage = 'Password does not meet requirements';
    } else if (error.code === 'InvalidParameterException') {
      statusCode = 400;
      errorMessage = 'Invalid parameters provided';
    }

    return {
      statusCode,
      body: JSON.stringify({
        error: errorMessage,
        code: error.code,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    };
  }
};
