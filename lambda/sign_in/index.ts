import * as AWS from 'aws-sdk';

const cognito = new AWS.CognitoIdentityServiceProvider();

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';

interface SignInRequest {
  email: string;
  password: string;
}

interface AuthenticationResult {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
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
  console.log('Sign-in request:', event);

  try {
    const body: SignInRequest = JSON.parse(event.body);
    const { email, password } = body;

    if (!email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing email or password',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    }

    // Use AdminInitiateAuth for server-side authentication
    const params: AWS.CognitoIdentityServiceProvider.AdminInitiateAuthRequest = {
      AuthFlow: 'ADMIN_NO_SRP_AUTH',
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    };

    const response = await cognito.adminInitiateAuth(params).promise();

    if (!response.AuthenticationResult) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          error: 'Authentication failed',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    }

    const authResult: AuthenticationResult = {
      idToken: response.AuthenticationResult.IdToken || '',
      accessToken: response.AuthenticationResult.AccessToken || '',
      refreshToken: response.AuthenticationResult.RefreshToken || '',
      expiresIn: response.AuthenticationResult.ExpiresIn || 3600,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(authResult),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    };
  } catch (error: any) {
    console.error('Sign-in error:', error);

    let statusCode = 500;
    let errorMessage = 'Internal server error';

    if (error.code === 'UserNotConfirmedException') {
      statusCode = 403;
      errorMessage = 'User not confirmed';
    } else if (error.code === 'NotAuthorizedException') {
      statusCode = 401;
      errorMessage = 'Invalid email or password';
    } else if (error.code === 'UserNotFoundException') {
      statusCode = 404;
      errorMessage = 'User not found';
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
